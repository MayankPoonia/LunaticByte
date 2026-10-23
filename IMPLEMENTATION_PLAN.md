# Implementation plan and handoff

Durable record of what is done, what is verified, what remains, and the decisions taken. Update it whenever work moves.

Last updated: 2026-10-23. Branch: `claude/hopeful-darwin-9rs2lr` (fast-forwarded to `main` after PR #1 was merged).

## Current state in one paragraph

All mandatory workflows are implemented end to end and verified on the **official data pack** in `data/`: the batch
command reproduces all 150 sample rows and all 24 expected alerts exactly, the evaluation-batch outputs are in `output/`,
and the XGBoost model trained on the official labelled file reaches PR-AUC 0.663 against a rules-only baseline of 0.133
(5.0x). 106 backend tests and 8 model tests pass. The transaction simulator is a standalone page at `/simulator`. The model
container retrains from scratch on every start. Docker Compose files are written but could not be executed in the build
environment (no Docker daemon); the same services were run natively and the demo flow was exercised in a browser.

**Next recommended action:** run `docker compose up --build -d` on the demo machine, wait for `ml` and `backend` to be
healthy, then `docker compose exec backend npm test` and `docker compose exec backend node src/cli/perf.js --url http://gateway`.

## Phase checklist

### Phase 1: discovery and planning
- [x] Read the case study and the team design spec in full
- [x] Inspect repository and tooling
- [x] Extract rules R1-R13, definitions, lifecycles, output formats, SLAs (HLD sections 5-6)
- [x] Inspect the official data pack (schemas, rule-config key names, worked-example cards C1001-C1010 owned by one customer)

### Phase 2: infrastructure and backend foundation
- [x] PostgreSQL schema (idempotent migration), advisory-locked seed and reset from the data pack
- [x] Express API structure, environment configuration, structured logging
- [x] JWT authentication, gateway API key, server-side role checks, demo accounts
- [x] Redis connection that fails fast (no offline queue)
- [x] Docker Compose: gateway (Nginx), frontend, backend x2, ml, postgres, redis; health checks; volumes
- [ ] `docker compose up --build` executed end to end. **Not run here** (no Docker daemon in the build environment)

### Phase 3: core authorisation
- [x] Validation of every field with field-level 422 errors
- [x] Idempotency on txn_id (payload hash; replay, 409 on conflict, concurrent duplicates)
- [x] Feature calculation (velocity_10m/24h, approved_today, avg_amount_30d, speed_kmph, new merchant, model features)
- [x] Rules engine R1-R13 with precedence, hard stops, score cap; all parameters from the official configuration file
- [x] Per-card row lock for concurrent same-card transactions
- [x] Persistence of decision, features, rule evaluation, model data, config version
- [x] Step-up lifecycle with simulated OTP (log + simulated inbox), CONFIRM / NOT_ME / timeout job, attempts limit
- [x] Alert creation policy, priority, SLA, claim/close with 409 on conflicts, maker-checker with 403
- [x] Append-only audit (database trigger), configuration change audit with before/after
- [x] Batch command producing decisions / alerts / fraud scores CSVs with `--verify` (150/150 sample rows, 24/24 alerts)
- [x] Evaluation-batch deliverables in `output/` (306 rows, 44 alerts, 7.3 s)
- [x] Replay script (simulated gateway at a configurable rate)

### Phase 4: machine learning
- [x] Schema validation, out-of-time split, seed 42, excluded columns
- [x] Imbalance handling chosen on a validation slice; early stopping; served booster cut at the best iteration
- [x] XGBoost model, TreeSHAP top factors, plain-language explanations
- [x] Rules-only baseline (AI-1 definition), Isolation Forest second detector (evaluation only)
- [x] Cost-based threshold analysis, segment friction table, latency measurement
- [x] Trained and reported on the official labelled file (`ml/evaluation_report.md`, `ml/model_card.md`, `output/evaluation_report.md`)
- [x] Flask service: model loaded once, /health, /model/info, /predict with validation
- [x] Integration with 150 ms budget and MODEL_UNAVAILABLE fallback; AI kill switch
- [x] 10 labelled frauds approved by the rules baseline and scored >= 0.70 by the model, shown on the Model page and re-scored by tests
- [x] Retrain from scratch on every `ml` container start; backends wait for the trained model
- [ ] AI-4 second score on the alert screen (Isolation Forest is evaluated but not served) - optional SHOULD
- [ ] AI-5 LLM alert narrative - optional MAY, not started

### Phase 5: frontend and real-time
- [x] Login with demo role selector (credentials filled from seeded accounts; role decided by the server)
- [x] Fraud dashboard (FR-9) with date filter, live refresh and demo reset (manager)
- [x] Standalone transaction simulator at `/simulator` (outside the console): single send, sequential batches (max 50),
      scenarios from the official sample batch, fixed/auto ids and timestamps, live round-trip timer (`performance.now()`),
      server and model latency, expandable details (features, SHAP factors), session avg/p95, idempotent retry
- [x] Transaction detail with rule-by-rule evaluation, feature values, SHAP factors, step-up, audit, CSV export
- [x] Alert queue (priority, SLA, SLA_BREACHED), investigation and resolution, approvals for managers
- [x] Audit trail page, rule configuration page (manager edits, analysts read), model page, test runner page
- [x] Cardholder screens: verify payments, transactions with neutral messages, cards with block, simulated SMS inbox
- [x] Socket.IO with JWT, rooms per role/customer, reconnect + REST refresh, duplicate suppression
- [x] Transactional outbox -> Redis Streams -> per-replica consumer groups (verified across two replicas)

### Phase 6: testing and performance
- [x] Test categories A-H (106 tests) and ML unit tests; CLI runner and Test Runner page
- [x] Latency measured on the official data (see `docs/TESTING.md`)
- [x] Browser walkthrough of the demo flow on the official data
- [ ] Re-measure latency inside Docker behind Nginx on the demo machine

### Phase 7: documentation and delivery
- [x] `README.md`, `HLD.md`, `docs/API.md`, `docs/TESTING.md`, `.env.example`, OpenAPI + Swagger UI
- [x] `output/design/design_document.md` (decision flowchart, lifecycles, ER diagram, technology decisions)
- [x] Evaluation-batch outputs committed in `output/`

## Commands

| Task | Command |
|---|---|
| Start everything (trains the model) | `docker compose up --build -d` then http://localhost:8080 and http://localhost:8080/simulator |
| Reset demo data | UI: Fraud dashboard "Reset demo data" (manager), or `docker compose exec backend node src/cli/seed.js --reset` |
| Sample batch with verification | `docker compose exec backend node src/cli/batch.js --file sample --verify` |
| Evaluation batch outputs | `docker compose exec backend node src/cli/batch.js --file eval` |
| Replay a file through the API | `docker compose exec backend node src/cli/replay.js --file eval --rate 5 --url http://gateway` |
| All tests | `docker compose exec backend npm test` |
| Model tests | `docker compose exec ml python -m pytest -q tests` |
| Performance | `docker compose exec backend node src/cli/perf.js --url http://gateway` |
| Retrain | `docker compose restart ml` |

## Assumptions and interpretations

Each is a reading of the case study where it is silent or ambiguous. Change the code in the file named if the judges say
otherwise. All of them are consistent with the official sample batch (150 / 150 rows, 24 / 24 alerts).

1. **Rule-config JSON keys** (`backend/src/services/ruleConfig.js`): the official key names are mapped explicitly onto the
   internal parameters (for example `velocity_stepup_min` to `velocity_step_up_count`, `false_positive_manager_limit` to
   `maker_checker_limit`, points keyed by reason code to R7-R12, `odd_hour_end: 4` meaning through 04:59). Only
   `rule_risk_score_cap`, `domestic_country`, `ai_enabled` and `otp_max_attempts` are not in the file and use defaults.
2. **Velocity window** includes a prior transaction exactly 10 minutes earlier (`>= ts - 10 min`); a prior transaction with
   the same timestamp is not "strictly earlier" and is not counted. The simulator's "current time" uses millisecond
   precision so rapid sequential sends get distinct timestamps.
3. **Look-back windows** for 30 days, 6 hours and 90 days are inclusive at the boundary, like the velocity window.
4. **Expiry (R1)**: "expiry_date earlier than the transaction date" compares IST dates; a card expiring today is valid.
   A card status other than ACTIVE (BLOCKED, EXPIRED) triggers R1.
5. **Batch mode**: the rules-only decision drives state (`decisions_output.csv`, alerts, approved history); the AI-2 decision
   per row is computed from the same features and written to `fraud_scores_output.csv` without feeding back into later
   rows. Alerts in batch mode use rules-only priority and `txn_ts` as creation time.
6. **Step-up expiry in live mode** is measured from processing time (wall clock), not from `txn_ts`, because demo
   transactions may carry historical timestamps.
7. **OTP**: CONFIRM requires the correct 6-digit OTP; NOT_ME is accepted without an OTP (it only makes the outcome
   stricter). After 3 wrong OTPs (`otp_max_attempts`) the request cannot be confirmed and will time out.
8. **Model escalation is one step**: APPROVE with a score of 0.90 or more becomes STEP_UP, not BLOCK ("uncertain band leads
   to STEP_UP"; example 13). `HIGH_FRAUD_SCORE_MODEL` is appended after the rule codes (example 14).
9. **The model scores every transaction**, including hard stops, so `fraud_scores_output.csv` has a score for every row;
   it cannot change a BLOCK.
10. **Manager decision comment** also needs 10 characters; REJECT makes the alert CONFIRMED_FRAUD and blocks the card.
11. **Analysts can read** the audit trail and rule configuration (read-only); only managers change configuration.
12. **The simulator** is a standalone page (`/simulator`) outside the analyst / manager console. It calls a separate
    endpoint that runs the same authorisation service (the gateway key never reaches the browser). In `DEMO_MODE` it needs
    no login and is audited as actor `simulator`; with `DEMO_MODE=false` it requires an analyst or manager token.
15. **The model is retrained from scratch on every start** of the `ml` container (user request); training is deterministic,
    so the same labelled file always yields the same model file.
16. **`case_01_EVALUATOR_ONLY_eval_answer_key_V1.0.csv`** is never read by the system, the tests or the training.
13. **Card number hash** is salted SHA-256 (not reversible, only for matching); only the last 4 digits are displayed.
14. **Confirmed step-ups keep their original decision** (`decision` = STEP_UP, `status` = APPROVED); the stored idempotent
    response stays the original response.

## Deviations from the team design spec (and why)

| Spec | Implemented | Reason |
|---|---|---|
| scikit-learn HistGradientBoosting / LogisticRegression | XGBoost | The user asked for XGBoost; the case study allows it; TreeSHAP explanations are exact and fast |
| Single backend container | Two replicas behind Nginx | The user asked for load balancing; per-replica consumer groups keep live updates correct |
| `apps/` and `packages/` monorepo layout | `backend/`, `frontend/`, `ml/` | Fewer moving parts to explain during the evaluation |
| Push to `main` (master prompt) | Pushed to `claude/hopeful-darwin-9rs2lr` | The session was configured to develop on this branch; merge when ready |

## Risks and open items

- The cost analysis (missed fraud = amount, false alarm = INR 150) favours a step-up threshold near 0.07 instead of the
  case study's 0.70 (expected cost on the test period INR 4.7 lakh vs 39.6 lakh). The case-study values are kept; a manager
  can change `ai_step_up_threshold` on the Rules page if the judges agree.
- Every `ml` start retrains (30-60 s), so the stack takes about a minute to become healthy.
- Nginx resolves the backend replicas when it starts; after changing `BACKEND_REPLICAS` restart the gateway.
- `batch.js` resets the database by design (the case study asks for a freshly loaded history); it wipes demo activity.
