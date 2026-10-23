"""
Train and evaluate the FraudShield XGBoost fraud-risk model (case study AI-1, AI-3, AI-4).

    python train.py                 # uses DATA_DIR, ../data or ../devdata (synthetic fallback)

Steps
  1. Load and validate the labelled file (schema, label values, class balance).
  2. Out-of-time split: train on txn_ts < 2026-01-01, test on later rows. Seed 42.
  3. Inside the training period, hold out the latest 20% (by time) as a validation slice used for
     early stopping, the class-imbalance setting and the cost-based threshold (the test set is
     never used for any choice).
  4. Train XGBoost, evaluate against the rules-only baseline and an Isolation Forest.
  5. Save model + metadata to artifacts/, write evaluation_report.md and model_card.md.
"""
import glob
import json
import os
import sys
import time
from datetime import datetime, timezone

import numpy as np
import pandas as pd
import xgboost as xgb
from sklearn.ensemble import IsolationForest
from sklearn.metrics import average_precision_score, confusion_matrix, precision_score, recall_score, roc_auc_score

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from fraudml.features import BINARY, CATEGORICAL, FEATURES, NUMERIC, build_vocab, encode_frame, to_binary, to_number, top_factors  # noqa: E402

SEED = 42
SPLIT = pd.Timestamp("2026-01-01T00:00:00+05:30")
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
ARTIFACTS = os.environ.get("ML_ARTIFACTS", os.path.join(HERE, "artifacts"))
OUTPUT = os.environ.get("OUTPUT_DIR", os.path.join(ROOT, "output"))
REPORT_DIR = os.environ.get("ML_REPORT_DIR", HERE)
FALSE_ALARM_COST = 150.0
STEP_UP_T, BLOCK_T = 0.70, 0.90  # AI-2 thresholds from the case study / rules config
HIGH_RISK_MCC = {"4829", "5967", "6051", "7995"}
REQUIRED = ["txn_id", "txn_ts", "is_fraud"] + FEATURES + ["city_tier"]


def find_labelled():
    dirs = [os.environ.get("DATA_DIR"), os.path.join(ROOT, "data"), os.path.join(ROOT, "devdata")]
    for d in [x for x in dirs if x]:
        hits = sorted(glob.glob(os.path.join(d, "case_01_labelled_transactions*.csv")))
        if hits:
            return hits[0], os.path.exists(os.path.join(d, "SYNTHETIC_DATA_README.txt"))
    raise SystemExit("labelled file not found: copy case_01_labelled_transactions_V1.0.csv into data/")


def load(path):
    df = pd.read_csv(path, dtype={"mcc": str, "txn_id": str})
    missing = [c for c in REQUIRED if c not in df.columns]
    if missing:
        raise SystemExit(f"labelled file is missing columns: {missing}")
    df["mcc"] = df["mcc"].astype(str).str.strip().str.zfill(4)
    df["ts"] = pd.to_datetime(df["txn_ts"], utc=True, format="ISO8601")
    if df["ts"].isna().any():
        raise SystemExit("unparseable txn_ts values")
    labels = set(df["is_fraud"].unique().tolist())
    if not labels <= {0, 1}:
        raise SystemExit(f"is_fraud must be 0/1, found {labels}")
    return df.sort_values(["ts", "txn_id"]).reset_index(drop=True)


def baseline_score(df):
    """Rules-only baseline exactly as defined in AI-1, computed from the file's columns."""
    v = pd.to_numeric(df["velocity_10m"], errors="coerce").fillna(0)
    amount = pd.to_numeric(df["amount"], errors="coerce").fillna(0)
    ratio = pd.to_numeric(df["amount_to_avg30_ratio"], errors="coerce")
    is_int = df["is_international"].astype(str).str.upper().isin(["1", "Y", "TRUE", "1.0"])
    risk_high = df["country_risk_high"].astype(str).str.upper().isin(["1", "Y", "TRUE", "1.0"])
    new_m = df["new_merchant_flag"].astype(str).str.upper().isin(["1", "Y", "TRUE", "1.0"])
    hour = pd.to_numeric(df["local_hour"], errors="coerce")
    pts = ((v >= 3) & (v <= 4)) * 25
    pts += (((ratio > 5) & (amount >= 10000)) | (ratio.isna() & (amount >= 50000))) * 30
    pts += (is_int & risk_high) * 25
    pts += df["mcc"].isin(HIGH_RISK_MCC) * 15
    pts += ((hour >= 0) & (hour <= 4) & (amount >= 20000)) * 15
    pts += ((df["channel"] == "ECOM") & new_m & (amount >= 25000)) * 20
    score = np.minimum(pts, 100).astype(float)
    score[(v >= 5) | (df["merchant_risk"].astype(str).str.upper() == "BLACKLISTED")] = 100.0
    return score.to_numpy()


def at_threshold(y, score, t):
    pred = (score >= t).astype(int)
    tn, fp, fn, tp = confusion_matrix(y, pred, labels=[0, 1]).ravel()
    return {
        "threshold": round(float(t), 4),
        "precision": float(precision_score(y, pred, zero_division=0)),
        "recall": float(recall_score(y, pred, zero_division=0)),
        "tp": int(tp), "fp": int(fp), "fn": int(fn), "tn": int(tn),
        "flag_rate": float(pred.mean()),
    }


def expected_cost(y, score, amount, t):
    pred = score >= t
    missed = float(amount[(y == 1) & ~pred].sum())
    false_alarms = int(((y == 0) & pred).sum())
    return missed + FALSE_ALARM_COST * false_alarms, missed, false_alarms


def fit(X_tr, y_tr, X_va, y_va, spw):
    model = xgb.XGBClassifier(
        n_estimators=600, max_depth=4, learning_rate=0.05, subsample=0.8, colsample_bytree=0.8, min_child_weight=5,
        reg_lambda=1.0, scale_pos_weight=spw, eval_metric="aucpr", early_stopping_rounds=40, random_state=SEED,
        n_jobs=4, tree_method="hist",
    )
    model.fit(X_tr, y_tr, eval_set=[(X_va, y_va)], verbose=False)
    return model


def segment_table(df, score, flagged_rules, t):
    genuine = df["is_fraud"].to_numpy() == 0
    rows = []
    for dim in ["city_tier", "card_type"]:
        seg_rows = []
        for value in sorted(df[dim].astype(str).unique()):
            m = genuine & (df[dim].astype(str).to_numpy() == value)
            n = int(m.sum())
            if n == 0:
                continue
            model_rate = float((score[m] >= t).mean())
            system_rate = float(((score[m] >= t) | flagged_rules[m]).mean())
            seg_rows.append({"dimension": dim, "segment": value, "genuine_txns": n, "model_friction_rate": model_rate,
                             "system_friction_rate": system_rate})
        for key in ["model_friction_rate", "system_friction_rate"]:
            rates = [r[key] for r in seg_rows]
            hi, lo = max(rates), min(rates)
            ratio = lo / hi if hi > 0 else 1.0
            for r in seg_rows:
                r[f"{key}_ratio"] = ratio
        rows.extend(seg_rows)
    return rows


def explain_disparity(df, dim, segment):
    """Data-driven hint: which features differ most for the highest-friction segment."""
    genuine = df[df["is_fraud"] == 0]
    inside = genuine[genuine[dim].astype(str) == segment]
    outside = genuine[genuine[dim].astype(str) != segment]
    diffs = []
    for c in ["is_international", "country_risk_high", "distance_from_home_km", "amount", "velocity_10m", "new_merchant_flag", "card_age_days"]:
        a = pd.to_numeric(inside[c], errors="coerce")
        b = pd.to_numeric(outside[c], errors="coerce")
        sd = pd.to_numeric(genuine[c], errors="coerce").std() or 1.0
        diffs.append((abs(a.mean() - b.mean()) / sd, c, a.mean(), b.mean()))
    diffs.sort(reverse=True)
    return [f"{c}: mean {a:,.2f} in {segment} vs {b:,.2f} elsewhere" for _, c, a, b in diffs[:3]]


def main():
    path, synthetic = find_labelled()
    print(f"loading {path}{' (SYNTHETIC)' if synthetic else ''}")
    df = load(path)
    np.random.seed(SEED)

    train = df[df["ts"] < SPLIT].reset_index(drop=True)
    test = df[df["ts"] >= SPLIT].reset_index(drop=True)
    cut = int(len(train) * 0.8)
    fit_part, val_part = train.iloc[:cut], train.iloc[cut:]
    vocab = build_vocab(train)
    X_fit, X_val, X_test = (encode_frame(d, vocab) for d in (fit_part, val_part, test))
    y_fit, y_val, y_test = (d["is_fraud"].to_numpy() for d in (fit_part, val_part, test))
    neg, pos = int((y_fit == 0).sum()), int((y_fit == 1).sum())

    # Class imbalance: choose scale_pos_weight on the validation slice (PR-AUC), never on test.
    candidates = {"1 (unweighted)": 1.0, "sqrt(neg/pos)": float(np.sqrt(neg / pos)), "neg/pos": neg / pos}
    tried = []
    for name, spw in candidates.items():
        m = fit(X_fit, y_fit, X_val, y_val, spw)
        tried.append((average_precision_score(y_val, m.predict_proba(X_val)[:, 1]), name, spw, m))
        print(f"  scale_pos_weight {name}: validation PR-AUC {tried[-1][0]:.4f}")
    best_val, spw_name, spw, model = max(tried, key=lambda x: x[0])

    p_val = model.predict_proba(X_val)[:, 1]
    p_test = model.predict_proba(X_test)[:, 1]
    amount_val = pd.to_numeric(val_part["amount"]).to_numpy()
    amount_test = pd.to_numeric(test["amount"]).to_numpy()

    # Cost-based threshold chosen on validation: missed fraud costs its amount, a false alarm INR 150.
    grid = np.round(np.arange(0.05, 0.96, 0.01), 2)
    val_costs = [(expected_cost(y_val, p_val, amount_val, t)[0], t) for t in grid]
    cost_t = float(min(val_costs)[1])

    b_test = baseline_score(test)
    rules_flag = b_test > 0
    iso_cols = [FEATURES.index(c) for c in NUMERIC] + [FEATURES.index(c) for c in CATEGORICAL]
    med = np.nanmedian(X_fit, axis=0)
    fill = lambda X: np.where(np.isnan(X), med, X)[:, iso_cols]  # noqa: E731
    iso = IsolationForest(n_estimators=200, random_state=SEED, n_jobs=4).fit(fill(X_fit))
    iso_test = -iso.score_samples(fill(X_test))

    metrics = {
        "xgboost": {
            "pr_auc": float(average_precision_score(y_test, p_test)), "roc_auc": float(roc_auc_score(y_test, p_test)),
            "at_step_up_threshold": at_threshold(y_test, p_test, STEP_UP_T), "at_block_threshold": at_threshold(y_test, p_test, BLOCK_T),
            "at_cost_threshold": at_threshold(y_test, p_test, cost_t),
        },
        "baseline": {
            "pr_auc": float(average_precision_score(y_test, b_test / 100)), "roc_auc": float(roc_auc_score(y_test, b_test / 100)),
            "flag_any_rule": at_threshold(y_test, b_test, 1), "score_100": at_threshold(y_test, b_test, 100),
        },
        "isolation_forest": {"pr_auc": float(average_precision_score(y_test, iso_test)), "roc_auc": float(roc_auc_score(y_test, iso_test))},
    }
    costs = {}
    for name, t in [("step_up_0.70", STEP_UP_T), ("block_0.90", BLOCK_T), (f"cost_optimal_{cost_t:.2f}", cost_t)]:
        total, missed, fa = expected_cost(y_test, p_test, amount_test, t)
        costs[name] = {"threshold": t, "total_cost_inr": total, "missed_fraud_inr": missed, "false_alarms": fa}
    total, missed, fa = expected_cost(y_test, b_test, amount_test, 1)
    costs["baseline_any_rule"] = {"threshold": "score > 0", "total_cost_inr": total, "missed_fraud_inr": missed, "false_alarms": fa}

    segments = segment_table(test, p_test, rules_flag, STEP_UP_T)
    disparities = []
    for dim in ["city_tier", "card_type"]:
        seg = [s for s in segments if s["dimension"] == dim]
        for key in ["model_friction_rate", "system_friction_rate"]:
            if seg and seg[0][f"{key}_ratio"] < 0.8:
                worst = max(seg, key=lambda s: s[key])
                disparities.append({"dimension": dim, "metric": key, "ratio": seg[0][f"{key}_ratio"], "highest": worst["segment"],
                                    "drivers": explain_disparity(test, dim, worst["segment"])})

    # Inference latency of the exact path used by the Flask service (single row + SHAP contributions).
    booster = model.get_booster()
    booster.set_param({"nthread": 1})
    lat = []
    for i in range(300):
        d = xgb.DMatrix(X_test[i % len(X_test): i % len(X_test) + 1], missing=np.nan)
        t0 = time.perf_counter()
        booster.predict(d)
        booster.predict(d, pred_contribs=True)
        lat.append((time.perf_counter() - t0) * 1000)
    latency = {"p50_ms": float(np.percentile(lat, 50)), "p95_ms": float(np.percentile(lat, 95)), "samples": len(lat)}

    # Genuine frauds the rules-only baseline approves (score 0) but the model scores at or above 0.70.
    contrib = booster.predict(xgb.DMatrix(X_test, missing=np.nan), pred_contribs=True)[:, :-1]
    missed_idx = np.where((y_test == 1) & (b_test == 0) & (p_test >= STEP_UP_T))[0]
    missed_idx = missed_idx[np.argsort(-p_test[missed_idx])][:10]
    examples = []
    for i in missed_idx:
        row = test.iloc[i]
        clean = {}
        for c in FEATURES:
            v = row[c]
            if c in CATEGORICAL:
                clean[c] = None if pd.isna(v) else str(v)
            else:
                n = to_binary(v) if c in BINARY else to_number(v)
                clean[c] = None if np.isnan(n) else float(n)
        examples.append({"txn_id": row["txn_id"], "txn_ts": row["txn_ts"], "is_fraud": 1, "baseline_score": float(b_test[i]),
                         "fraud_score": round(float(p_test[i]), 4), "features": {c: clean[c] for c in FEATURES},
                         "top_factors": top_factors(contrib[i], clean)})

    os.makedirs(ARTIFACTS, exist_ok=True)
    model_path = os.path.join(ARTIFACTS, "model.json")
    booster.save_model(model_path)
    import hashlib
    digest = hashlib.sha256(open(model_path, "rb").read()).hexdigest()[:8]
    trained_at = datetime.now(timezone.utc)
    version = f"xgb-{trained_at:%Y%m%d%H%M}-{digest}"
    meta = {
        "model_version": version, "trained_at": trained_at.isoformat(), "dataset": os.path.basename(path), "synthetic_data": synthetic,
        "rows": {"total": len(df), "train": len(train), "fit": len(fit_part), "validation": len(val_part), "test": len(test)},
        "fraud_rate": {"train": float(train["is_fraud"].mean()), "test": float(test["is_fraud"].mean())},
        "split": "train txn_ts < 2026-01-01T00:00+05:30, test on or after", "seed": SEED, "features": FEATURES, "vocab": vocab,
        "scale_pos_weight": {"chosen": spw_name, "value": spw, "validation_pr_auc": {n: float(v) for v, n, _, _ in tried}},
        "best_iteration": int(model.best_iteration), "thresholds": {"step_up": STEP_UP_T, "block": BLOCK_T, "cost_optimal_validation": cost_t},
        "metrics": metrics, "costs": costs, "segments": segments, "disparities": disparities, "latency": latency,
        "rules_missed_examples": len(examples),
    }
    json.dump(meta, open(os.path.join(ARTIFACTS, "metadata.json"), "w"), indent=2, default=str)
    json.dump(examples, open(os.path.join(ARTIFACTS, "rules_missed_examples.json"), "w"), indent=2, default=str)

    from report import write_reports  # noqa: E402
    write_reports(meta, examples, [REPORT_DIR, OUTPUT])
    print(json.dumps({"model_version": version, "xgb_pr_auc": metrics["xgboost"]["pr_auc"], "baseline_pr_auc": metrics["baseline"]["pr_auc"],
                      "iforest_roc_auc": metrics["isolation_forest"]["roc_auc"], "cost_threshold": cost_t, "rules_missed_examples": len(examples)}, indent=2))


if __name__ == "__main__":
    main()
