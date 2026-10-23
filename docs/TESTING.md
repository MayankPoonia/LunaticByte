# Testing

FraudShield has 106 automated backend tests in 8 categories plus 8 model-service unit tests. They can be run from the
command line or from the **Test runner** page (Fraud Risk Manager).

## How the tests are isolated

- Every test file builds a fresh copy of a separate database (`<DATABASE_URL name>_test`, for example `fraudshield_test`)
  and loads deterministic fixtures from `backend/tests/fixtures.js`. They never read or change the live demo database and
  do not depend on which data pack is installed (except category H, test 2, which deliberately uses the installed pack).
- Fixture cards C1001-C1010 follow the worked-example defaults of the case study (ACTIVE DEBIT, home Mumbai, daily limit
  INR 1,00,000, 20 approved INR 2,400 purchases in the previous 30 days, plus the per-example history).
- The model is a programmable stub by default, so decision-policy tests (examples 13 and 14) are deterministic. Category C
  also tests the real Flask service at `ML_URL` and skips those tests, with the reason, when it is not reachable.
- Only one test run can execute at a time across all backend replicas (PostgreSQL advisory lock).

## Running

```bash
# Docker
docker compose exec backend npm test                        # all categories, summary per test
docker compose exec backend node src/cli/run-tests.js A C   # selected categories
docker compose exec ml python -m pytest -q tests            # model service unit tests

# Local (PostgreSQL and Redis running; model service optional)
cd backend && npm test
cd ml && python -m pytest -q tests
```

Single file with Node's own reporter: `cd backend && node --test --test-concurrency=1 tests/B_rules.test.js`.

## Categories

| Id | Category | File | What is covered |
|---|---|---|---|
| A | API and security | `A_api_security.test.js` (17) | Valid authorisation and response fields; missing or wrong gateway key (401); JWT vs gateway key separation; 422 with field names for every invalid field; amount limits and decimals; city/country consistency; unknown card; malformed JSON (400); idempotent replay (same response, one transaction, one audit decision, velocity not doubled); conflicting payload (409); concurrent duplicate ids; login and server-side roles; cardholder gets 403 on staff APIs; analyst gets 403 on manager APIs; standalone simulator works without login in demo mode (audited as `simulator`); manager cannot claim; object-level access (other cardholder's ids return 404); no full card numbers stored or returned |
| B | Rules engine | `B_rules.test.js` (34) | Each rule R1-R13 triggered and not triggered; boundaries (expiry on the day, daily limit equal, 5 x average exactly, INR 10,000 minimum, INR 50,000 without history, 04:59 vs 05:00, INR 25,000, 89 vs 91 days); precedence (hard stops list only R1/R2 and stop; R3-R6 list all and skip R7-R13; R13 listed last); score cap 100; velocity window inclusive at 10 minutes, same timestamp excluded; approved_today per IST date and APPROVED only; avg_amount_30d excludes BLOCKED and pending; speed only for physical channels within 6 hours; configuration drives thresholds, lists and points; the official rules-config format (points keyed by reason code, odd hours as whole hours, step-up max) maps onto every parameter; R7 upper bound from `velocity_step_up_max`; changing `velocity_burst_count` through the API changes the decision; 8 concurrent same-card transactions keep velocity correct; sequential burst 3 approve, 2 step up, 6th blocks |
| C | XGBoost model | `C_model.test.js` (15) | Real service: model loaded, version on /health; valid prediction (probability, 3 plain-language factors); deterministic; invalid features (422) and bad JSON (400); metadata shows out-of-time split and seed 42 and excluded columns; rules-missed fraud examples really score >= 0.70 (skipped when the data has none); end-to-end score and version stored. Stub: example 13 (APPROVE + 0.82 -> STEP_UP), example 14 (STEP_UP + 0.93 -> BLOCK, HIGH alert); never relaxes; APPROVE escalates at most to STEP_UP; timeout (400 ms stub) -> MODEL_UNAVAILABLE within 300 ms; error and service down -> fallback; AI kill switch; thresholds are configuration; features sent contain no card or customer data |
| D | Transaction lifecycle | `D_lifecycle.test.js` (10) | APPROVE with audit RECEIVED -> APPROVED; STEP_UP -> CONFIRM with OTP -> APPROVED (example 7), second response 409; wrong OTP 422 with attempts left, locked after 3; NOT_ME -> BLOCKED, STEP_UP_DENIED, card BLOCKED, HIGH alert, next transaction CARD_NOT_ACTIVE (example 11); timeout -> BLOCKED, STEP_UP_TIMEOUT, MEDIUM alert, card stays ACTIVE, job idempotent; response after expiry 409; other cardholder 404; idempotent retry of a step-up; cardholder blocks own card; neutral cardholder message |
| E | Alerts and concurrency | `E_alerts.test.js` (16) | HIGH alert with 30-minute SLA (example 5); MEDIUM 240 minutes; INR 50,000 makes HIGH; policy declines create no alert; queue order and SLA_BREACHED; two analysts claim at once (200 + 409); only the claimer closes; comment of 10+ characters; CONFIRMED_FRAUD blocks the card and stores feedback; two simultaneous closes (200 + 409); FALSE_POSITIVE up to INR 1,00,000 closes directly with notification; maker-checker (example 12: PENDING_MANAGER_APPROVAL, analyst 403, manager approves, second decision 409); proposer can never be checker even with a manager role (403); manager REJECT confirms fraud; audit append-only enforced by the database; transaction audit in order with CSV export; configuration audit before/after; dashboard reconciles with the database |
| F | Events and recovery | `F_events.test.js` (7) | Staff socket receives transaction_decided and alert_created within 5 s; cardholder socket receives only its own step-up events; invalid socket token rejected; reconnect + REST refresh recovers missed alerts; duplicate stream delivery handled once; Redis down after a committed decision (decision returned, outbox row kept with attempts and error, published exactly once after recovery); consumer measures delivery latency |
| G | Performance | `G_performance.test.js` (5) | Sequential velocity run through the simulator endpoint; 200 sequential authorisations p95 < 300 ms with the model; rules-only p95 < 150 ms; 10 parallel clients x 20 requests p95 < 300 ms; 300-row batch < 60 s with the correct output header |
| H | Batch and worked examples | `H_batch.test.js` (2) | Worked examples 1-10 through the batch command match the case study exactly (decision, codes, score, velocity, average, speed, alerts, empty cells, row order); the installed data pack's sample batch reproduces every `expected_*` column and the expected alerts file |
| ML | Model unit tests | `ml/tests/test_model.py` (8) | Training and inference encode features identically; unknown categories and missing ratio become missing values; validation; the AI-1 baseline formula; Flask health, prediction, determinism, invalid input |

## Last recorded run

Run on 2026-10-23 in the development container (4 vCPU, 15 GB RAM; PostgreSQL 16, Redis 7, model service with 2 gunicorn
workers x 8 threads, all on one host, no Docker), with the **official data pack** in `data/` and the model trained on the
official labelled file:

| Category | Passed | Failed | Skipped |
|---|---|---|---|
| A API and security | 17 | 0 | 0 |
| B Rules engine | 34 | 0 | 0 |
| C XGBoost model | 15 | 0 | 0 (the 10 rules-missed frauds re-score >= 0.70 on the served model) |
| D Transaction lifecycle | 10 | 0 | 0 |
| E Alerts and concurrency | 16 | 0 | 0 |
| F Events and recovery | 7 | 0 | 0 |
| G Performance | 5 | 0 | 0 |
| H Batch and worked examples | 2 | 0 | 0 (all 150 official sample rows and 24 expected alerts match) |
| ML unit tests | 8 | 0 | 0 |

Batch acceptance on the official data:

| Check | Result |
|---|---|
| `batch.js --file sample --verify` | 150 / 150 rows match every `expected_*` column; 24 / 24 expected alerts match (priority and `sla_due_at`) |
| `batch.js --file eval` | 306 rows in 7.3 s; 44 alerts; outputs in `output/decisions_output.csv`, `alerts_output.csv`, `fraud_scores_output.csv` |

Latency measured in that run (HTTP client to backend, real XGBoost service):

| Workload | p50 | p95 | Target |
|---|---|---|---|
| 200 sequential authorisations, with model | 18.1 ms | 27.8 ms | p95 < 300 ms |
| 200 sequential authorisations, rules-only | 10.2 ms | 19.1 ms | p95 < 150 ms |
| 10 parallel clients x 20 requests, with model | 80.8 ms | 149.4 ms | p95 < 300 ms |
| 300-row batch | 4.6 s total | | < 60 s |
| Alert raised on replica B visible on a socket of replica A | about 100 ms | | < 5 s |

These numbers are from one machine without Docker or Nginx. Re-measure on the demo machine with
`docker compose exec backend node src/cli/perf.js --url http://gateway` (it prints p50/p95/p99, model status counts and
which replica served each request) before quoting them.

## Bugs the real data exposed (fixed)

- Average rounding: four sample rows expected half-up rounding (for example 3756.615 to 3756.62); binary floating point
  rounded them down. `avg_amount_30d` is now rounded from the exact paise sum.
- Model parity: the evaluation used the early-stopping best iteration while the saved booster kept every tree, so served
  scores differed slightly from the reported ones (category C caught it). The booster is now cut at the best iteration
  before evaluation and saving.
- Rule configuration: the official JSON names (`velocity_stepup_min/max`, points keyed by reason code, `odd_hour_end: 4`
  meaning through 04:59, `false_positive_manager_limit`, `alert_high_amount`, `impossible_travel_kmph`,
  `avg_lookback_days`, `earth_radius_km`) are now mapped explicitly.

## Manual checks (UI)

| Check | Expected |
|---|---|
| Simulator "Send 6 sequentially" on one card | Requests sent one at a time; velocity_10m column 0,1,2,3,4,5; decisions APPROVE x3, STEP_UP x2, BLOCK |
| Round-trip timer | Counts up while the request is in flight; final value matches the Round trip column; server and model times shown separately |
| New alert while the analyst queue is open in another tab | Appears without refresh within a second or two |
| Stop the model (`docker compose stop ml`) and send a transaction | Decision returned; model badge "AI score unavailable"; dashboard counts MODEL_UNAVAILABLE |
| Sign in as a cardholder | Only own cards, transactions and verifications; neutral messages; no reason codes or scores |

## Known limitations

- Performance figures above were measured without Docker; Docker and Nginx add a small overhead.
- Docker Compose itself could not be executed in the build environment (no Docker daemon); the stack was verified with the
  same services running natively. Run `docker compose up --build` once before the demo.
