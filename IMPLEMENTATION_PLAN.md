# Implementation plan and handoff

Durable record of what is done, what is verified, what remains, and the decisions taken. Update it whenever work moves.

Last updated: 2026-10-23. Branch: `claude/hopeful-darwin-9rs2lr` (pushed to GitHub; not merged to `main`).

## Current state in one paragraph

All mandatory workflows are implemented end to end and covered by 103 backend tests (102 pass, 1 skipped by design on the
synthetic data) and 8 model tests. The official data pack was **not available** while building, so everything was
developed and verified against a schema-identical synthetic stand-in (`scripts/generate_synthetic_data.py`, worked
examples 1-10 reproduced exactly). Docker Compose files are written but could not be executed in the build environment
(no Docker daemon); the same services were run natively and the browser flow was exercised with Playwright.

**Next recommended action:** copy the official files into `data/`, run `docker compose up --build -d`, then
`docker compose exec backend node src/cli/batch.js --file sample --verify` and `docker compose exec backend npm test`.
Fix any mismatch it reports (most likely a rule-config key name, see Assumptions 1).

## Phase checklist

### Phase 1: discovery and planning
- [x] Read the case study and the team design spec in full
- [x] Inspect repository (empty apart from `.gitignore`) and tooling
- [x] Extract rules R1-R13, definitions, lifecycles, output formats, SLAs (HLD sections 5-6)
- [ ] Inspect the official data pack. **Blocked**: files not provided in the session; synthetic stand-in used meanwhile

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
- [x] Rules engine R1-R13 with precedence, hard stops, score cap; all parameters from configuration
- [x] Per-card row lock for concurrent same-card transactions
- [x] Persistence of decision, features, rule evaluation, model data, config version
- [x] Step-up lifecycle with simulated OTP (log + simulated inbox), CONFIRM / NOT_ME / timeout job, attempts limit
- [x] Alert creation policy, priority, SLA, claim/close with 409 on conflicts, maker-checker with 403
- [x] Append-only audit (database trigger), configuration change audit with before/after
- [x] Batch command producing decisions / alerts / fraud scores CSVs with `--verify`
- [x] Replay script (simulated gateway at a configurable rate)

### Phase 4: machine learning
- [x] Schema validation, out-of-time split, seed 42, excluded columns
- [x] Imbalance handling chosen on a validation slice; early stopping
- [x] XGBoost model, TreeSHAP top factors, plain-language explanations
- [x] Rules-only baseline (AI-1 definition), Isolation Forest second detector (evaluation only)
- [x] Cost-based threshold analysis, segment friction table, latency measurement
- [x] Generated `ml/evaluation_report.md`, `output/evaluation_report.md`, `ml/model_card.md`
- [x] Flask service: model loaded once, /health, /model/info, /predict with validation
- [x] Integration with 150 ms budget and MODEL_UNAVAILABLE fallback; AI kill switch
- [x] Search for frauds missed by the rules that the model scores >= 0.70 (none in the synthetic data; re-run on real data)
- [ ] Train and report on the official labelled file. **Blocked** on the data pack
- [ ] AI-4 second score on the alert screen (Isolation Forest is evaluated but not served) - optional SHOULD
- [ ] AI-5 LLM alert narrative - optional MAY, not started

### Phase 5: frontend and real-time
- [x] Login with demo role selector (credentials filled from seeded accounts; role decided by the server)
- [x] Fraud dashboard (FR-9) with date filter and live refresh
- [x] Transaction simulator: single send, sequential batches (max 50), scenarios, fixed/auto ids and timestamps,
      live round-trip timer (`performance.now()`), server and model latency shown separately, session avg/p95, retry
- [x] Transaction detail with rule-by-rule evaluation, feature values, SHAP factors, step-up, audit, CSV export
- [x] Alert queue (priority, SLA, SLA_BREACHED), investigation and resolution, approvals for managers
- [x] Audit trail page, rule configuration page (manager edits, analysts read), model page, test runner page
- [x] Cardholder screens: verify payments, transactions with neutral messages, cards with block, simulated SMS inbox
- [x] Socket.IO with JWT, rooms per role/customer, reconnect + REST refresh, duplicate suppression
- [x] Transactional outbox -> Redis Streams -> per-replica consumer groups (verified across two replicas)

### Phase 6: testing and performance
- [x] Test categories A-H (103 tests) and ML unit tests; CLI runner and Test Runner page
- [x] Latency measured (see `docs/TESTING.md`); 300-row batch in about 4 s
- [x] Browser walkthrough of the demo flow (simulator, velocity, step-up confirm, claim, maker-checker, dashboard)
- [ ] Verify the 150 sample rows and 24 expected alerts. **Blocked** on the data pack
- [ ] Re-measure latency inside Docker behind Nginx on the demo machine

### Phase 7: documentation and delivery
- [x] `README.md`, `HLD.md`, `docs/API.md`, `docs/TESTING.md`, `.env.example`, OpenAPI + Swagger UI
- [x] `output/design/design_document.md` (decision flowchart, lifecycles, ER diagram, technology decisions)
- [ ] Produce `output/decisions_output.csv`, `alerts_output.csv`, `fraud_scores_output.csv` for the evaluation batch
      (`batch.js --file eval`) once the official file is present, and commit them with `git add -f`
- [ ] Merge the branch to `main` when the team is happy (this session pushed only the feature branch)

## Commands

| Task | Command |
|---|---|
| Start everything | `docker compose up --build -d` then http://localhost:8080 |
| Reset demo data | UI: simulator page "Reset demo data" (manager), or `docker compose exec backend node src/cli/seed.js --reset` |
| Sample batch with verification | `docker compose exec backend node src/cli/batch.js --file sample --verify` |
| Evaluation batch outputs | `docker compose exec backend node src/cli/batch.js --file eval` |
| Replay a file through the API | `docker compose exec backend node src/cli/replay.js --file eval --rate 5 --url http://gateway` |
| All tests | `docker compose exec backend npm test` |
| Model tests | `docker compose exec ml python -m pytest -q tests` |
| Performance | `docker compose exec backend node src/cli/perf.js --url http://gateway` |
| Retrain | `docker compose run --rm ml python train.py && docker compose restart ml` |
| Synthetic data | `python3 scripts/generate_synthetic_data.py` |

## Assumptions and interpretations

Each is a reading of the case study where it is silent or ambiguous. Change the code in the file named if the official data
or the judges say otherwise.

1. **Rule-config JSON keys** (`backend/src/services/ruleConfig.js`): the file's structure was unknown. Parameters are found
   by exact name or common aliases anywhere in the JSON (nested allowed); anything not found uses the case-study default and
   is reported in the seed log (`config_defaults_used`) and on the Rules page (source "default"). Add aliases in `PARAMS`
   if the real file uses other names.
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
12. **The simulator** is a staff screen (analyst, manager) that calls the same authorisation service through a staff
    endpoint, because the gateway key must never reach the browser.
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

- Real data could reveal schema details (date formats, Y/N encodings, key names) not covered by the loaders. The loaders
  accept common variants (offset or no offset timestamps, Y/N/1/0/TRUE booleans), but verify with the sample batch first.
- Model quality on the real data is unknown until trained; do not quote metrics from the synthetic run.
- Nginx resolves the backend replicas when it starts; after changing `BACKEND_REPLICAS` restart the gateway.
- `batch.js` resets the database by design (the case study asks for a freshly loaded history); it wipes demo activity.
