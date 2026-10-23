# API reference

The complete, machine-readable contract is the OpenAPI document served by the backend:

- Swagger UI: http://localhost:8080/api/docs
- JSON: http://localhost:8080/api/openapi.json (source: `backend/src/openapi.js`)

This page summarises the contract and documents the model service.

## Authentication

| Caller | How | Used for |
|---|---|---|
| Transaction gateway (simulated card network) | Header `X-API-Key: <GATEWAY_API_KEY>` | `POST /api/v1/authorisations` only. Missing or wrong key: 401. A gateway key on any other API: 401. |
| People (cardholder, analyst, manager) | `POST /api/v1/auth/login` returns a JWT; send `Authorization: Bearer <token>` | Every other `/api/v1` route. Wrong role: 403. Cardholder routes are scoped to the token's customer (other ids return 404). |

## Error format

```json
{ "error": "VALIDATION_ERROR", "message": "Invalid request", "fields": [{ "field": "amount", "message": "must be greater than 0 and at most 1000000.00" }] }
```

| Status | Meaning |
|---|---|
| 400 | Body is not valid JSON / not an object |
| 401 | Missing or invalid credentials |
| 403 | Role not allowed, or maker-checker violation (`MAKER_CHECKER_VIOLATION`) |
| 404 | Not found (or not yours, for cardholders) |
| 409 | State conflict: idempotency conflict, alert already claimed, not in the expected status, step-up already resolved or expired, test run in progress |
| 422 | Field validation failed (`fields[]` lists every invalid field), wrong OTP (`INVALID_OTP`) |

## Authorisation API

`POST /api/v1/authorisations` (gateway key)

Request (case study section 4):

```json
{
  "txn_id": "T200000007", "card_id": "C1007", "txn_ts": "2026-03-04T14:05:00+05:30", "amount": "15000.00",
  "currency": "INR", "merchant_id": "M00451", "mcc": "5732", "channel": "ECOM", "txn_city": "Mumbai", "txn_country": "IN"
}
```

Response (201 new, 200 idempotent replay with header `Idempotent-Replay: true`):

```json
{
  "txn_id": "T200000007",
  "decision": "STEP_UP",
  "reason_codes": ["AMOUNT_SPIKE"],
  "rule_risk_score": 30,
  "status": "STEP_UP_PENDING",
  "alert_id": null,
  "processed_at": "2026-10-23T14:38:04+05:30",
  "fraud_score": 0.0386,
  "top_factors": [{ "feature": "amount_to_avg30_ratio", "value": 6.25, "contribution": 0.81, "direction": "raises", "text": "amount 6.2x the card's 30-day average" }],
  "model_status": "OK",
  "model_version": "xgb-202610230910-ff867552",
  "rules_decision": "STEP_UP",
  "step_up": { "step_up_id": 1, "expires_at": "2026-10-23T09:23:04.000Z" },
  "features": { "velocity_10m": 0, "approved_today": 0, "avg_amount_30d": 2400, "speed_kmph": null, "new_merchant": false },
  "model_latency_ms": 9.4,
  "processing_ms": 21.7
}
```

- `rule_risk_score` is `null` after a hard stop (R1/R2).
- `model_status`: `OK`, `MODEL_UNAVAILABLE` (error or slower than `model_timeout_ms`, rules-only decision returned) or
  `DISABLED` (`ai_enabled` switched off).
- Idempotency: same `txn_id` and same payload returns the stored response; same `txn_id` with a different payload returns
  409 `IDEMPOTENCY_CONFLICT`. No duplicate transaction, alert, audit record or velocity count is ever created.

## Endpoint summary

| Method and path | Role | Purpose |
|---|---|---|
| `POST /api/v1/auth/login` | public | Sign in |
| `GET /api/v1/auth/me` | any user | Current user |
| `GET /api/v1/auth/demo-accounts` | public, DEMO_MODE | Accounts for the login selector |
| `GET /api/v1/simulator/options`, `/scenarios`, `/next-id` | analyst, manager | Simulator reference data, demo scenarios, fresh txn_id |
| `POST /api/v1/simulator/transactions` | analyst, manager | Same authorisation service; `txn_id` optional, `txn_ts` may be `"now"` |
| `GET /api/v1/transactions`, `/transactions/{id}` | analyst, manager | List; detail with rule evaluation, features, model, step-up, alert, audit |
| `GET /api/v1/cards/{id}` | analyst, manager | Masked card and recent transactions |
| `GET /api/v1/alerts`, `/alerts/{id}` | analyst, manager | Queue (priority, then SLA) and investigation view |
| `POST /api/v1/alerts/{id}/claim` | analyst | OPEN -> IN_REVIEW (409 if already claimed) |
| `POST /api/v1/alerts/{id}/close` | claiming analyst | `{ outcome: CONFIRMED_FRAUD or FALSE_POSITIVE, comment (10+ chars) }` |
| `POST /api/v1/alerts/{id}/manager-decision` | manager, not the proposer | `{ decision: APPROVE or REJECT, comment }` |
| `GET /api/v1/me/cards`, `/me/transactions`, `/me/transactions/{id}`, `/me/step-ups`, `/me/notifications` | cardholder | Own data only |
| `POST /api/v1/me/step-ups/{id}/respond` | cardholder | `{ response: CONFIRM, otp }` or `{ response: NOT_ME }` |
| `POST /api/v1/me/cards/{id}/block` | cardholder | Block own card |
| `GET /api/v1/dashboard/summary?from&to` | analyst, manager | FR-9 figures |
| `GET /api/v1/audit`, `/audit/{entity}/{id}?format=csv` | analyst, manager | Recent events; ordered history and CSV export |
| `GET /api/v1/config`, `PUT /api/v1/config/{key}` | read: staff; write: manager | Rule configuration, versioned and audited |
| `GET /api/v1/model/info`, `POST /api/v1/model/score` | analyst, manager | Model metrics and live scoring (proxy to the model service) |
| `POST /api/v1/demo/reset`, `/demo/step-ups/{id}/expire` | manager, DEMO_MODE | Reset demo data; expire a step-up now |
| `GET /api/v1/test-runner/categories`, `POST /api/v1/test-runner/run` | manager | Run test categories |
| `GET /api/v1/system/status` | analyst, manager | Instance, data pack, model health, outbox backlog, event latency |
| `GET /health`, `GET /ready` | public | Liveness; readiness (database required, Redis and model reported) |

## Real-time events (Socket.IO)

Connect to path `/socket.io` with `auth: { token }` and the `websocket` transport. Staff sockets join the `staff` room; a
cardholder socket joins only its own customer room. Each message is emitted as `event`:

```json
{ "event_id": "42", "type": "alert_created", "created_at": "2026-10-23T09:07:05.123Z", "payload": { "alert_id": 3, "txn_id": "T700000010", "priority": "HIGH" } }
```

| Type | Audience | When |
|---|---|---|
| `transaction_decided` | staff | Every new decision |
| `transaction_updated` | staff | Step-up confirmed, denied or timed out |
| `alert_created`, `alert_updated` | staff | Alert raised, claimed, closed, proposed, decided |
| `step_up_updated` | staff and the owning cardholder | Step-up requested or resolved |
| `card_updated` | staff and the owning cardholder | Card blocked |

Events are notifications only: clients refresh from REST, and refresh again on every reconnect.

## Model service (Flask, internal port 5000)

Not exposed through the gateway; the backend calls it, and staff reach it through `/api/v1/model/*`.

| Method and path | Purpose |
|---|---|
| `GET /health` | `{ status: "UP", model_loaded: true, model_version }`; 503 with the error when the model is not loaded |
| `GET /model/info` | Training metadata, metrics (model, baseline, Isolation Forest), costs, segments, latency, rules-missed examples |
| `POST /predict` | Score one transaction |

`POST /predict` request:

```json
{ "features": {
  "card_type": "DEBIT", "channel": "ECOM", "mcc": "6051", "mcc_category": "QUASI_CASH", "merchant_risk": "MEDIUM",
  "amount": 45000, "local_hour": 2, "is_international": 0, "country_risk_high": 0, "distance_from_home_km": 0,
  "velocity_10m": 0, "velocity_24h": 0, "amount_to_avg30_ratio": 18.75, "new_merchant_flag": 1, "card_age_days": 1144 } }
```

Optional (may be null): `amount_to_avg30_ratio`, `distance_from_home_km`, `card_age_days`, `mcc_category`, `merchant_risk`.
Unknown categories are treated as missing values.

Response:

```json
{ "fraud_score": 0.349427, "model_status": "OK", "model_version": "xgb-202610230910-ff867552", "latency_ms": 3.3,
  "top_factors": [
    { "feature": "amount_to_avg30_ratio", "value": 18.75, "contribution": 1.5561, "direction": "raises", "text": "amount 18.8x the card's 30-day average" },
    { "feature": "mcc_category", "value": "QUASI_CASH", "contribution": 0.463, "direction": "raises", "text": "merchant category QUASI_CASH" },
    { "feature": "amount", "value": 45000.0, "contribution": 0.3938, "direction": "raises", "text": "amount INR 45,000.00" } ] }
```

Errors: 400 (not JSON), 422 `{ error: "VALIDATION_ERROR", fields: [...] }`, 503 `MODEL_NOT_LOADED`.

Failure behaviour: the backend waits at most `model_timeout_ms` (150 ms). Any error, non-200 response, invalid score or
timeout gives `model_status = MODEL_UNAVAILABLE` and the rules-only decision; the authorisation itself never fails because
of the model.
