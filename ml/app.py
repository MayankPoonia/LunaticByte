"""
FraudShield model service (Flask). Loads the trained XGBoost model once at start-up and serves:

  GET  /health       liveness + readiness (model loaded?)
  GET  /model/info   version, training metadata, metrics, rules-missed examples
  POST /predict      {"features": {...}} -> fraud_score, top_factors, model_version, latency_ms

The model is never retrained per request. Inputs contain no card numbers or customer data.
"""
import json
import logging
import os
import sys
import time

import numpy as np
import xgboost as xgb
from flask import Flask, jsonify, request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from fraudml.features import FEATURES, encode_one, top_factors, validate_features  # noqa: E402

ARTIFACTS = os.environ.get("ML_ARTIFACTS", os.path.join(os.path.dirname(os.path.abspath(__file__)), "artifacts"))
logging.basicConfig(level=logging.INFO, format='{"ts":"%(asctime)s","level":"%(levelname)s","msg":%(message)s}')
log = logging.getLogger("fraudshield-ml")

app = Flask(__name__)
STATE = {"booster": None, "meta": None, "examples": [], "error": None}


def load_model():
    try:
        booster = xgb.Booster()
        booster.load_model(os.path.join(ARTIFACTS, "model.json"))
        booster.set_param({"nthread": 1})  # single-row inference is fastest single-threaded
        with open(os.path.join(ARTIFACTS, "metadata.json")) as f:
            meta = json.load(f)
        if meta["features"] != FEATURES:
            raise ValueError("model feature list does not match fraudml.features")
        examples_path = os.path.join(ARTIFACTS, "rules_missed_examples.json")
        examples = json.load(open(examples_path)) if os.path.exists(examples_path) else []
        STATE.update(booster=booster, meta=meta, examples=examples, error=None)
        log.info(json.dumps(f"model loaded {meta['model_version']}"))
    except Exception as exc:  # the service stays up and reports the problem on /health
        STATE.update(booster=None, error=str(exc))
        log.error(json.dumps(f"model not loaded: {exc}"))


load_model()


@app.get("/health")
def health():
    ok = STATE["booster"] is not None
    body = {"status": "UP" if ok else "DOWN", "model_loaded": ok,
            "model_version": STATE["meta"]["model_version"] if ok else None, "error": STATE["error"]}
    return jsonify(body), 200 if ok else 503


@app.get("/model/info")
def info():
    if STATE["booster"] is None:
        return jsonify({"error": "MODEL_NOT_LOADED", "message": STATE["error"]}), 503
    meta = {k: v for k, v in STATE["meta"].items() if k != "vocab"}
    return jsonify({**meta, "rules_missed_examples": STATE["examples"]})


@app.post("/predict")
def predict():
    started = time.perf_counter()
    if STATE["booster"] is None:
        return jsonify({"error": "MODEL_NOT_LOADED", "message": STATE["error"]}), 503
    body = request.get_json(silent=True)
    if not isinstance(body, dict):
        return jsonify({"error": "INVALID_JSON", "message": "JSON object with a 'features' object expected"}), 400
    errors, clean = validate_features(body.get("features"))
    if errors:
        return jsonify({"error": "VALIDATION_ERROR", "fields": errors}), 422

    matrix = xgb.DMatrix(encode_one(clean, STATE["meta"]["vocab"]), missing=np.nan)
    score = float(STATE["booster"].predict(matrix)[0])
    contribs = STATE["booster"].predict(matrix, pred_contribs=True)[0][:-1]  # last column is the bias
    latency = (time.perf_counter() - started) * 1000
    # Log latency only; no transaction identifiers or card data are sent to this service.
    log.info(json.dumps(f"predict score={score:.4f} latency_ms={latency:.2f}"))
    return jsonify({
        "fraud_score": round(score, 6),
        "top_factors": top_factors(contribs, clean),
        "model_version": STATE["meta"]["model_version"],
        "model_status": "OK",
        "latency_ms": round(latency, 3),
    })


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 5000)))
