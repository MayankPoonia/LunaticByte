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
# copy the case-study data pack into ./data (see "Data pack" below)
docker compose up --build -d
docker compose ps                 # wait until backend and ml show "healthy" (first start trains the model, about 1 minute)
```

Open http://localhost:8080.

| URL | What |
|---|---|
| http://localhost:8080 | Application |
| http://localhost:8080/api/docs | Swagger UI (OpenAPI 3) |
| http://localhost:8080/api/openapi.json | OpenAPI document |
| http://localhost:8080/ready | Backend readiness (database, Redis, model) |

Stop with `docker compose down` (data is kept in volumes) or `docker compose down -v` (also deletes the database).

## Data pack

Put the official files in `./data` with their original names, for example:

```
data/case_01_customers_V1.0.csv            data/case_01_transactions_history_V1.0.csv
data/case_01_cards_V1.0.csv                data/case_01_batch_transactions_sample_V1.0.csv
data/case_01_merchants_V1.0.csv            data/case_01_batch_sample_expected_alerts_V1.0.csv
data/case_01_mcc_codes_V1.0.csv            data/case_01_batch_transactions_eval_V1.0.csv
data/case_01_cities_V1.0.csv               data/case_01_labelled_transactions_V1.0.csv
data/case_01_country_risk_V1.0.csv         data/case_01_rules_config_V1.0.json
```

Files are found by pattern (`case_01_<name>_*.csv`), so a different version suffix is fine. The application never
modifies them.

If `./data` is empty, the model container generates a **synthetic stand-in** in `./devdata` (same file names and columns;
cards C1001-C1010 and sample rows T200000001-T200000010 reproduce worked examples 1-10). The UI shows a yellow banner while
the synthetic data is in use. After copying the real files:

```bash
docker compose restart ml                                   # retrains automatically (the labelled file changed)
docker compose exec backend node src/cli/seed.js --reset    # reload the database from ./data
```

Check the seed log for `config_defaults_used`: it lists any rule parameter that the JSON file did not provide (the
case-study default is used for those and the Rules page shows source "default").

## Demo accounts

The login page has a **Sign in as** selector (demo mode only) that fills in the credentials. All demo accounts use the
password `Demo@123` (`DEMO_PASSWORD`). The role always comes from the server-side account.

| Username | Role | Use |
|---|---|---|
| `manager1`, `manager2` | Fraud Risk Manager | Dashboard, approvals (maker-checker), rule configuration, audit, test runner, demo reset |
| `analyst1`, `analyst2` | Fraud Analyst | Alert queue, claim and close alerts, simulator |
| cardholder accounts | Cardholder | One per customer (username from `customers.csv`); the selector lists the owners of cards C1001-C1010 first |

Each browser tab keeps its own session, so you can be the analyst in one tab and the cardholder in another.

Prefilled credentials and the demo endpoints exist only while `DEMO_MODE=true`. Never use them outside the demo
environment.

## Live demo walkthrough (about 6 minutes)

1. **Sign in** as `manager1` (tab 1). Open **Transaction simulator**.
2. **Normal transaction**: load *Normal purchase*, click **Send transaction**. Result APPROVE; the round-trip timer and the
   server processing time are shown separately.
3. **Rule triggered**: load *Impossible travel* (Mumbai, then Delhi one hour later = 1148.09 km/h). Result BLOCK with
   IMPOSSIBLE_TRAVEL and a HIGH alert.
4. **Velocity**: load *Velocity burst*, click **Send 6 sequentially**. Requests go one after another on the same card:
   APPROVE x3, STEP_UP x2 (HIGH_VELOCITY), then BLOCK (VELOCITY_BURST). The velocity_10m column counts up 0..5.
5. **Step-up**: load *Amount spike needs step-up*, send it (STEP_UP). In tab 2, sign in as the cardholder of C1007, open
   **Verify payments**, read the OTP from the simulated SMS panel and click **Yes, it was me** (APPROVED), or **No** to see
   STEP_UP_DENIED, the card blocked and a HIGH alert. A manager can click **Expire now (demo)** on the transaction page to
   show STEP_UP_TIMEOUT.
6. **Alert queue**: sign in as `analyst1` (another tab). New alerts appear without refreshing. **Claim** an alert, review
   the feature values, rule evaluation and AI factors, close it with a comment of at least 10 characters.
7. **Maker-checker**: as manager, load *High-value alert* (INR 1,20,000 at a blacklisted merchant). As analyst, claim it and
   choose False positive: it goes to PENDING_MANAGER_APPROVAL. The analyst cannot approve (HTTP 403); `manager1` approves it
   on **Approvals**.
8. **Real-time dashboard**: **Fraud dashboard** updates live as decisions arrive (by decision, block and step-up rates, open
   alerts by priority, SLA breaches, false-positive rate, top 5 reason codes, latency).
9. **Model**: every decision shows the XGBoost fraud score, model status and top 3 factors. **Model** shows the evaluation.
   To show model escalation, lower `ai_step_up_threshold` on **Rule configuration** (audited) and resend a transaction;
   to show the fallback, run `docker compose stop ml` and send any transaction (AI score unavailable, rules-only decision).
10. **Configurability**: on **Rule configuration** change `velocity_burst_count` from 5 to 3 and repeat step 4.
11. **Tests**: **Test runner** runs each category on an isolated test database.
12. **API and architecture**: http://localhost:8080/api/docs and [HLD.md](HLD.md).

Reset to a clean state at any time: **Reset demo data** on the simulator page (manager), or
`docker compose exec backend node src/cli/seed.js --reset`.

## Batch outputs (FR-10)

```bash
# sample batch with verification against the expected_* columns and expected alerts file
docker compose exec backend node src/cli/batch.js --file sample --verify
# evaluation batch -> output/decisions_output.csv, output/alerts_output.csv, output/fraud_scores_output.csv
docker compose exec backend node src/cli/batch.js --file eval
```

Each run resets the database first (freshly loaded history, as the case study requires) and processes rows in `txn_ts`
order (ties by `txn_id`). This wipes demo activity; use `--no-reset` to keep it. Output CSVs are git-ignored by default;
add the final ones with `git add -f output/*.csv`.

Replay a file through the gateway API at a chosen rate (acts as the simulated card network):

```bash
docker compose exec backend node src/cli/replay.js --file eval --rate 5 --url http://gateway
```

## Model training

```bash
docker compose run --rm ml python train.py      # retrain and regenerate ml/model_card.md and the evaluation reports
docker compose restart ml                       # load the new model
```

Training is reproducible (seed 42, out-of-time split, one command). Reported metrics are produced by the run itself.

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
# data: copy the official files into ./data, or generate the synthetic stand-in
python3 scripts/generate_synthetic_data.py
# model service
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
| `backend` keeps restarting with "No data pack found" | Put the files in `./data`, or let the `ml` container generate `./devdata` (check `docker compose logs ml`) |
| Every decision shows "AI score unavailable" | `docker compose ps ml` and `docker compose logs ml`; the first start trains for about a minute. Decisions stay correct (rules-only). |
| Dashboard says "Reconnecting to live updates" | Check `docker compose logs gateway backend`; the page also refreshes through REST on reconnect |
| Port 8080 in use | Set `GATEWAY_PORT` in `.env` |
| Login fails for demo users | `DEMO_PASSWORD` changed after seeding: reset (`seed.js --reset`) or use the old password |
| After scaling backends, some replicas get no traffic | `docker compose restart gateway` so Nginx resolves the new replicas |
| Real data copied but the model still says synthetic | `docker compose restart ml` (it retrains when the labelled file changes) |

## Project structure

```
backend/        Node.js API (src/engine rules + features, src/services, src/routes, src/events, src/cli, tests/)
frontend/       React + Tailwind application
ml/             Flask model service, train.py, report.py, fraudml/features.py, tests/, model card and evaluation report
nginx/          Gateway configuration
scripts/        Synthetic data generator
data/           Official case-study data pack (not modified by the application)
devdata/        Generated synthetic stand-in (git-ignored)
output/         Batch outputs and evaluation report; output/design/ holds the design document
docs/           API and testing documentation
```
