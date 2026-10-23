"""
Feature definitions shared by training (train.py) and inference (app.py), so both encode a
transaction exactly the same way. Meanings follow case study 6.1.2 and the labelled file.
Excluded on purpose (AI-1): txn_id, txn_ts, city_tier. No customer or card-number data is used.
"""
import math

import numpy as np

NUMERIC = [
    "amount", "local_hour", "is_international", "country_risk_high", "distance_from_home_km",
    "velocity_10m", "velocity_24h", "amount_to_avg30_ratio", "new_merchant_flag", "card_age_days",
]
CATEGORICAL = ["card_type", "channel", "mcc", "mcc_category", "merchant_risk"]
FEATURES = NUMERIC + CATEGORICAL
BINARY = {"is_international", "country_risk_high", "new_merchant_flag"}
OPTIONAL = {"amount_to_avg30_ratio", "distance_from_home_km", "card_age_days", "mcc_category", "merchant_risk"}

TRUE_VALUES = {"1", "Y", "YES", "TRUE", "T"}
FALSE_VALUES = {"0", "N", "NO", "FALSE", "F"}


def to_binary(v):
    if v is None or (isinstance(v, float) and math.isnan(v)):
        return np.nan
    s = str(v).strip().upper()
    if s in TRUE_VALUES or s == "1.0":
        return 1.0
    if s in FALSE_VALUES or s == "0.0":
        return 0.0
    return np.nan


def to_number(v):
    if v is None or v == "":
        return np.nan
    try:
        return float(v)
    except (TypeError, ValueError):
        return np.nan


def build_vocab(df):
    """Sorted category values seen in training; unseen values at inference become missing."""
    return {c: sorted(df[c].dropna().astype(str).str.strip().unique().tolist()) for c in CATEGORICAL}


def encode_frame(df, vocab):
    """pandas DataFrame -> float matrix (n x len(FEATURES)), NaN for missing."""
    cols = []
    for c in NUMERIC:
        if c in BINARY:
            cols.append(df[c].map(to_binary).astype(float).to_numpy())
        else:
            cols.append(df[c].map(to_number).astype(float).to_numpy())
    for c in CATEGORICAL:
        index = {v: i for i, v in enumerate(vocab[c])}
        cols.append(df[c].map(lambda v: index.get(str(v).strip(), np.nan) if v is not None else np.nan).astype(float).to_numpy())
    return np.column_stack(cols)


def validate_features(features):
    """Validate one inference payload. Returns (errors, cleaned dict)."""
    errors = []
    if not isinstance(features, dict):
        return [{"field": "features", "message": "object expected"}], None
    clean = {}
    for c in FEATURES:
        v = features.get(c)
        if v is None or v == "":
            if c not in OPTIONAL:
                errors.append({"field": c, "message": "is required"})
            clean[c] = None
            continue
        if c in CATEGORICAL:
            clean[c] = str(v)
        elif c in BINARY:
            b = to_binary(v)
            if np.isnan(b):
                errors.append({"field": c, "message": "must be 0/1"})
            clean[c] = b
        else:
            n = to_number(v)
            if np.isnan(n) or n < 0:
                errors.append({"field": c, "message": "must be a non-negative number"})
            clean[c] = n
    if clean.get("local_hour") is not None and not np.isnan(clean["local_hour"]) and not 0 <= clean["local_hour"] <= 23:
        errors.append({"field": "local_hour", "message": "must be 0-23"})
    return errors, clean


def encode_one(clean, vocab):
    row = []
    for c in NUMERIC:
        v = clean.get(c)
        row.append(np.nan if v is None else float(v))
    for c in CATEGORICAL:
        v = clean.get(c)
        row.append(float(vocab[c].index(v)) if v is not None and v in vocab[c] else np.nan)
    return np.array([row], dtype=float)


def describe(feature, value):
    """Plain-language text for a contributing feature (shown to analysts, never to cardholders)."""
    missing = value is None or (isinstance(value, float) and math.isnan(value))
    if feature == "amount_to_avg30_ratio":
        return "no 30-day spending history on the card" if missing else f"amount {value:.1f}x the card's 30-day average"
    if missing:
        return f"{feature.replace('_', ' ')} not available"
    if feature == "amount":
        return f"amount INR {value:,.2f}"
    if feature == "velocity_10m":
        return f"{int(value)} earlier transaction(s) in the previous 10 minutes"
    if feature == "velocity_24h":
        return f"{int(value)} earlier transaction(s) in the previous 24 hours"
    if feature == "local_hour":
        return f"transaction at {int(value):02d}:00 IST"
    if feature == "is_international":
        return "international transaction" if value else "domestic transaction"
    if feature == "country_risk_high":
        return "transaction in a high-risk country" if value else "transaction in a low-risk country"
    if feature == "distance_from_home_km":
        return f"{value:,.0f} km from the card's home city"
    if feature == "new_merchant_flag":
        return "first transaction with this merchant in 90 days" if value else "known merchant for this card"
    if feature == "card_age_days":
        return f"card issued {int(value)} days ago"
    if feature == "card_type":
        return f"{value} card"
    if feature == "channel":
        return f"{value} channel"
    if feature == "mcc":
        return f"merchant category code {value}"
    if feature == "mcc_category":
        return f"merchant category {value}"
    if feature == "merchant_risk":
        return f"merchant risk level {value}"
    return f"{feature} = {value}"


def top_factors(contribs, clean, k=3):
    """contribs: SHAP values for FEATURES (bias excluded). Returns the k features that push the score
    up the most (if fewer than k push it up, the next largest contributions follow, marked 'lowers')."""
    order = np.argsort(-contribs)
    out = []
    for i in order[:k]:
        f = FEATURES[i]
        v = clean.get(f)
        v = None if isinstance(v, float) and math.isnan(v) else v
        out.append({"feature": f, "value": v, "contribution": round(float(contribs[i]), 4),
                    "direction": "raises" if contribs[i] > 0 else "lowers", "text": describe(f, v)})
    return out
