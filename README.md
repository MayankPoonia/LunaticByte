# FraudShield

Real-time card transaction fraud detection, step-up verification and alert management for the fictional Kaveri National
Bank (BFSI hackathon, use case 01).

Every transaction is decided in milliseconds by a configurable rules engine (R1-R13) plus an XGBoost fraud score that can
only make a decision stricter. Doubtful payments are confirmed with the cardholder through a simulated OTP, genuinely
suspicious ones reach a prioritised analyst queue with SLA, high-value releases need a second person, and every decision
and action is audited.

- Architecture and design decisions: [HLD.md](HLD.md)
- Progress, assumptions and handoff: [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md)
- API reference: Swagger UI at http://localhost:8080/api/docs, summary in [docs/API.md](docs/API.md)
- Tests: [docs/TESTING.md](docs/TESTING.md)
- Model: [ml/model_card.md](ml/model_card.md), [ml/evaluation_report.md](ml/evaluation_report.md)

## Stack

| Layer | Technology |
|---|---|
| Frontend | React 18, Tailwind CSS, Vite |
| Backend | Node.js 22, Express 5, Socket.IO, Swagger UI |
| Model service | Python 3.13, Flask, gunicorn, XGBoost, scikit-learn |
| Data | PostgreSQL 16 (source of truth), Redis 7 Streams (event log) |
| Infrastructure | Docker Compose, Nginx gateway / load balancer (2 backend replicas) |

## Quick start (Docker)

Prerequisites: Docker with the Compose plugin (Docker Desktop or Docker Engine 24+), ports 8080 free, about 3 GB of disk.

```bash
git clone https://github.com/MayankPoonia/LunaticByte.git
cd LunaticByte
cp .env.example .env              # optional: change secrets and ports
docker compose up --build -d      # the data pack is already in ./data
docker compose ps                 # wait until ml, backend and gateway show "healthy"
```

On **every start** the `ml` container trains the XGBoost model from scratch on `data/case_01_labelled_transactions_V1.0.csv`
(about 30-60 seconds), regenerates `ml/model_card.md` and the evaluation reports, and only then reports healthy. The
backends wait for it, so the first transaction is already scored by the freshly trained model. Training is deterministic
(seed 42): the same data always produces the same model file.

Open http://localhost:8080.

| URL | What |
|---|---|
| http://localhost:8080 | Operations console (dashboard, alerts, approvals, audit, rules, model, test runner) |
| http://localhost:8080/simulator | Transaction simulator (standalone simulated card gateway, no login needed in demo mode) |
| http://localhost:8080/api/docs | Swagger UI (OpenAPI 3) |
| http://localhost:8080/api/openapi.json | OpenAPI document |
| http://localhost:8080/ready | Backend readiness (database, Redis, model) |

Stop with `docker compose down` (data is kept in volumes) or `docker compose down -v` (also deletes the database).

```

Files are found by pattern (`case_01_<name>_*.csv`), so a different version suffix is fine. The application never
modifies them. The backend loads everything except the labelled file into PostgreSQL on first start (1,191 cards, 455
merchants, 47,403 history transactions); the model service trains on the labelled file. `case_01_EVALUATOR_ONLY_*` is not
read by any part of the system.

Every rule parameter comes from `case_01_rules_config_V1.0.json` (the seed log's `config_defaults_used` lists only the four
operational switches the file does not define: `rule_risk_score_cap`, `domestic_country`, `ai_enabled`, `otp_max_attempts`).
After changing a data file, reload with `docker compose exec backend node src/cli/seed.js --reset` and
`docker compose restart ml`.

## Demo accounts

The login page has a **Sign in as** selector (demo mode only) that fills in the credentials. All demo accounts use the
password `Demo@123` (`DEMO_PASSWORD`). The role always comes from the server-side account.

| Username | Role | Use |
|---|---|---|
| `manager1`, `manager2` | Fraud Risk Manager | Dashboard, approvals (maker-checker), rule configuration, audit, test runner, demo reset |
| `analyst1`, `analyst2` | Fraud Analyst | Alert queue, claim and close alerts |
| `asha.kulkarni9001` | Cardholder | Owns the worked-example cards C1001-C1010 (verifies the step-up scenario) |
| other cardholders | Cardholder | One per customer (username from `customers.csv`); the selector lists a few |

Each browser tab keeps its own session, so you can be the analyst in one tab and the cardholder in another.

Prefilled credentials, the demo endpoints and login-free access to the simulator exist only while `DEMO_MODE=true`
(with `DEMO_MODE=false` the simulator needs an analyst or manager login). Never use them outside the demo environment.

## Live demo walkthrough (about 6 minutes)

1. Open the **transaction simulator** at http://localhost:8080/simulator (tab 1, no login). In tab 2 sign in as `manager1`
   (dashboard), in tab 3 as `analyst1` (alert queue).
2. **Normal transaction**: load *Normal purchase*, click **Send transaction**. Result APPROVE; the round-trip timer and the
   server processing time are shown separately.
3. **Rule triggered**: load *Impossible travel* (Mumbai, then Delhi one hour later = 1148.09 km/h). Result BLOCK with
   IMPOSSIBLE_TRAVEL and a HIGH alert.
4. **Velocity**: load *Velocity burst*, click **Send 6 sequentially**. Requests go one after another on the same card:
   APPROVE x3, STEP_UP x2 (HIGH_VELOCITY), then BLOCK (VELOCITY_BURST). The velocity_10m column counts up 0..5.
5. **Step-up**: load *Amount spike needs step-up*, send it (STEP_UP). In tab 4, sign in as `asha.kulkarni9001` (owner of C1007), open
   **Verify payments**, read the OTP from the simulated SMS panel and click **Yes, it was me** (APPROVED), or **No** to see
   STEP_UP_DENIED, the card blocked and a HIGH alert. A manager can click **Expire now (demo)** on the transaction page to
   show STEP_UP_TIMEOUT.
6. **Alert queue**: in the analyst tab, new alerts appear without refreshing. **Claim** an alert, review
   the feature values, rule evaluation and AI factors, close it with a comment of at least 10 characters.
7. **Maker-checker**: in the simulator, load *High-value alert* (INR 1,20,000 at a blacklisted merchant). As analyst, claim it and
   choose False positive: it goes to PENDING_MANAGER_APPROVAL. The analyst cannot approve (HTTP 403); `manager1` approves it
   on **Approvals**.
8. **Real-time dashboard**: **Fraud dashboard** updates live as decisions arrive (by decision, block and step-up rates, open
   alerts by priority, SLA breaches, false-positive rate, top 5 reason codes, latency).
9. **Model**: every decision shows the XGBoost fraud score, model status and top 3 factors (click **Details** in the
   simulator). **Model** shows the evaluation and 10 labelled frauds the rules miss but the model catches (**Score now**
   re-scores them live).
   To show model escalation, lower `ai_step_up_threshold` on **Rule configuration** (audited) and resend a transaction;
   to show the fallback, run `docker compose stop ml` and send any transaction (AI score unavailable, rules-only decision).
10. **Configurability**: on **Rule configuration** change `velocity_burst_count` from 5 to 3 and repeat step 4.
11. **Tests**: **Test runner** runs each category on an isolated test database.
12. **API and architecture**: http://localhost:8080/api/docs and [HLD.md](HLD.md).

Reset to a clean state at any time: **Reset demo data** on the Fraud dashboard (manager), or
`docker compose exec backend node src/cli/seed.js --reset`.

## Batch outputs (FR-10)

```bash
# sample batch with verification against the expected_* columns and expected alerts file
docker compose exec backend node src/cli/batch.js --file sample --verify
# evaluation batch -> output/decisions_output.csv, output/alerts_output.csv, output/fraud_scores_output.csv
docker compose exec backend node src/cli/batch.js --file eval
```

Each run resets the database first (freshly loaded history, as the case study requires) and processes rows in `txn_ts`
order (ties by `txn_id`). This wipes demo activity; use `--no-reset` to keep it. The committed `output/*.csv` files are the
evaluation-batch deliverables (306 rows, 44 alerts, processed in about 7 seconds).

Replay a file through the gateway API at a chosen rate (acts as the simulated card network):

```bash
docker compose exec backend node src/cli/replay.js --file eval --rate 5 --url http://gateway
```

## Model training

The model is retrained from scratch every time the `ml` container starts. To retrain on demand:

```bash
docker compose restart ml        # retrains on data/case_01_labelled_transactions_V1.0.csv, then serves the new model
```

Training is reproducible (seed 42, out-of-time split, one command). Reported metrics are produced by the run itself.
Test-period results on the official file: XGBoost PR-AUC 0.663 vs rules-only baseline 0.133 (5.0x), ROC-AUC 0.929;
at the 0.70 step-up threshold precision 0.94 and recall 0.32. Details: [ml/evaluation_report.md](ml/evaluation_report.md).

## Tests

```bash
docker compose exec backend npm test                          # every category
docker compose exec backend node src/cli/run-tests.js B E     # selected categories
docker compose exec ml python -m pytest -q tests              # model service unit tests
docker compose exec backend node src/cli/perf.js --url http://gateway   # performance against the SLA
```

Or use the **Test runner** page (manager). Tests run against a separate `<db>_test` database with deterministic fixtures,
so they never touch demo data. Categories and expected results: [docs/TESTING.md](docs/TESTING.md).

## Local development without Docker

Requirements: Node.js 22, Python 3.12+, PostgreSQL 16 and Redis 7 running locally.

```bash
# database
createuser -s fraudshield && psql -c "ALTER USER fraudshield PASSWORD 'fraudshield'" && createdb -O fraudshield fraudshield
# model service (trains on ./data, then serve it)
cd ml && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt && .venv/bin/python train.py
.venv/bin/gunicorn -w 2 -k gthread --threads 8 -b 0.0.0.0:5000 app:app          # terminal 1
# backend (seeds on first start)
cd backend && npm install && npm start                                           # terminal 2
# frontend (proxies /api and /socket.io to :4000)
cd frontend && npm install && npm run dev                                        # terminal 3 -> http://localhost:5173
```

## Configuration

Environment variables are documented in [.env.example](.env.example). Business parameters (thresholds, windows, points,
MCC list, SLA minutes, maker-checker limit, AI thresholds, model timeout, AI kill switch) live in the `rule_config` table,
are seeded from `case_01_rules_config_V1.0.json` and are edited on the **Rule configuration** page. Every change creates a
new version and an audit entry with before and after values.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `backend` keeps restarting with "No data pack found" | The case-study files must be in `./data` |
| `backend` is not starting yet | It waits for `ml` to finish training (about a minute); watch `docker compose logs -f ml` |
| Every decision shows "AI score unavailable" | `docker compose ps ml` and `docker compose logs ml`. Decisions stay correct (rules-only). |
| Dashboard says "Reconnecting to live updates" | Check `docker compose logs gateway backend`; the page also refreshes through REST on reconnect |
| Port 8080 in use | Set `GATEWAY_PORT` in `.env` |
| Login fails for demo users | `DEMO_PASSWORD` changed after seeding: reset (`seed.js --reset`) or use the old password |
| After scaling backends, some replicas get no traffic | `docker compose restart gateway` so Nginx resolves the new replicas |

## Project structure

```
backend/        Node.js API (src/engine rules + features, src/services, src/routes, src/events, src/cli, tests/)
frontend/       React + Tailwind application
ml/             Flask model service, train.py, report.py, fraudml/features.py, tests/, model card and evaluation report
nginx/          Gateway configuration
scripts/        Design-document builder
data/           Official case-study data pack (not modified by the application)
output/         Evaluation-batch outputs, evaluation report; output/design/ holds the design document
docs/           API and testing documentation
```
