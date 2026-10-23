"""ML unit tests: feature encoding parity, the AI-1 baseline definition and the Flask endpoints.
Run: cd ml && python -m pytest -q   (needs a trained model in ml/artifacts for the endpoint tests)"""
import os
import sys

import numpy as np
import pandas as pd
import pytest

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, HERE)

from fraudml.features import FEATURES, encode_frame, encode_one, validate_features  # noqa: E402
from train import baseline_score  # noqa: E402

ROW = {"card_type": "DEBIT", "channel": "ECOM", "mcc": "6051", "mcc_category": "QUASI_CASH", "merchant_risk": "MEDIUM", "amount": 45000,
       "local_hour": 2, "is_international": 0, "country_risk_high": 0, "distance_from_home_km": 0, "velocity_10m": 0, "velocity_24h": 0,
       "amount_to_avg30_ratio": 18.75, "new_merchant_flag": 1, "card_age_days": 1144}
VOCAB = {"card_type": ["CREDIT", "DEBIT"], "channel": ["ATM", "CONTACTLESS", "ECOM", "POS"], "mcc": ["5411", "6051"],
         "mcc_category": ["GROCERY", "QUASI_CASH"], "merchant_risk": ["HIGH", "LOW", "MEDIUM"]}


def test_training_and_inference_encode_identically():
    errors, clean = validate_features(ROW)
    assert errors == []
    one = encode_one(clean, VOCAB)
    frame = encode_frame(pd.DataFrame([ROW]), VOCAB)
    np.testing.assert_array_equal(np.nan_to_num(one, nan=-1), np.nan_to_num(frame, nan=-1))
    assert one.shape == (1, len(FEATURES))


def test_unknown_category_and_missing_ratio_become_missing_values():
    errors, clean = validate_features({**ROW, "mcc": "9999", "amount_to_avg30_ratio": None})
    assert errors == []
    x = encode_one(clean, VOCAB)[0]
    assert np.isnan(x[FEATURES.index("mcc")]) and np.isnan(x[FEATURES.index("amount_to_avg30_ratio")])


def test_validation_reports_each_bad_field():
    errors, _ = validate_features({**ROW, "amount": -1, "local_hour": 25, "channel": None})
    assert sorted(e["field"] for e in errors) == ["amount", "channel", "local_hour"]


def test_baseline_matches_ai1_definition():
    df = pd.DataFrame([
        {**ROW, "velocity_10m": 5},                                     # velocity >= 5 -> 100
        {**ROW, "merchant_risk": "BLACKLISTED"},                       # blacklisted -> 100
        {**ROW},                                                       # R8 30 + R10 15 + R11 15 + R12 20 = 80
        {**ROW, "mcc": "5411", "amount": 1000, "amount_to_avg30_ratio": 1, "local_hour": 12, "new_merchant_flag": 0},  # 0
        {**ROW, "mcc": "5411", "amount": 50000, "amount_to_avg30_ratio": None, "local_hour": 12, "new_merchant_flag": 0},  # no history -> 30
    ])
    assert baseline_score(df).tolist() == [100.0, 100.0, 80.0, 0.0, 30.0]


@pytest.fixture(scope="module")
def client():
    if not os.path.exists(os.path.join(HERE, "artifacts", "model.json")):
        pytest.skip("no trained model in ml/artifacts (run python train.py)")
    import app as service
    return service.app.test_client()


def test_health_reports_loaded_model(client):
    r = client.get("/health")
    assert r.status_code == 200 and r.get_json()["model_loaded"] is True


def test_predict_returns_probability_and_three_factors(client):
    r = client.post("/predict", json={"features": ROW})
    body = r.get_json()
    assert r.status_code == 200
    assert 0 <= body["fraud_score"] <= 1
    assert len(body["top_factors"]) == 3


def test_predict_is_deterministic(client):
    a = client.post("/predict", json={"features": ROW}).get_json()["fraud_score"]
    b = client.post("/predict", json={"features": ROW}).get_json()["fraud_score"]
    assert a == b


def test_predict_rejects_invalid_input(client):
    assert client.post("/predict", json={"features": {"amount": "abc"}}).status_code == 422
    assert client.post("/predict", data="nope", content_type="application/json").status_code == 400
