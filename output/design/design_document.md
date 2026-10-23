# FraudShield design document

Deliverable for case study section 6.6 (`/output/design`). Generated from [HLD.md](../../HLD.md); edit HLD.md and regenerate with `python3 scripts/build_design_doc.py`.

## Decision flowchart (R1 to R13 evaluation order)

Definitions follow case study 6.1 exactly: prior transactions are those of the same card with `txn_ts` strictly earlier;
`velocity_10m` counts prior transactions of any decision within the 10 minutes before; `approved_today` sums prior
APPROVED amounts on the same IST date; `avg_amount_30d` is the mean of prior APPROVED amounts in 30 days; `speed_kmph`
compares a physical transaction with the most recent prior APPROVED physical one within 6 hours (haversine, R = 6371 km);
a merchant is new when the card has no prior transaction with it in 90 days.

```mermaid
flowchart TD
  S([Validated transaction]) --> F[Compute features from stored history]
  F --> R1{R1 card not ACTIVE<br/>or expired?}
  R1 --> R2{R2 abroad and<br/>international disabled?}
  R2 --> H{R1 or R2 triggered?}
  H -- yes --> HB[BLOCK, R1/R2 codes only<br/>score and derived fields empty<br/>stop]
  H -- no --> B[Evaluate R3 blacklisted merchant,<br/>R4 daily limit, R5 velocity >= 5,<br/>R6 speed > 800 km/h]
  B --> BT{any of R3-R6?}
  BT -- yes --> BB[BLOCK, triggered R3-R6 codes,<br/>score 100, R7-R13 not evaluated]
  BT -- no --> SOFT[Evaluate R7 velocity 3-4: 25, R8 amount spike: 30,<br/>R9 high-risk geo: 25, R10 high-risk MCC: 15,<br/>R11 odd hour high value: 15, R12 new merchant ECOM: 20]
  SOFT --> R13{3 or more soft rules?}
  R13 -- yes --> RB[BLOCK, soft codes + MULTIPLE_RED_FLAGS<br/>score = sum, capped at 100]
  R13 -- no --> ANY{any soft rule?}
  ANY -- yes --> SU[STEP_UP, score = sum]
  ANY -- no --> AP[APPROVE, score 0]
  HB & BB & RB & SU & AP --> AI{model available?}
  AI -- no --> OUT[rules decision,<br/>model_status MODEL_UNAVAILABLE]
  AI -- yes --> POL{APPROVE and score >= 0.70?<br/>STEP_UP and score >= 0.90?}
  POL -- yes --> ESC[escalate one step,<br/>append HIGH_FRAUD_SCORE_MODEL]
  POL -- no --> OUT2[rules decision unchanged]
```

Alert policy (6.1.2): a BLOCKED transaction creates one alert only if a fraud-suspicion code is present
(MERCHANT_BLACKLISTED, VELOCITY_BURST, IMPOSSIBLE_TRAVEL, MULTIPLE_RED_FLAGS, STEP_UP_DENIED, STEP_UP_TIMEOUT,
HIGH_FRAUD_SCORE_MODEL). Policy declines (CARD_NOT_ACTIVE, INTL_NOT_ENABLED, DAILY_LIMIT_EXCEEDED only) create none.
Priority is HIGH for amount of INR 50,000 or more, IMPOSSIBLE_TRAVEL / MULTIPLE_RED_FLAGS / STEP_UP_DENIED, or a fraud
score of 0.90 or more; otherwise MEDIUM. `sla_due_at` = creation + 30 min (HIGH) or 240 min (MEDIUM); in batch mode the
creation time is `txn_ts`.

## Transaction and alert status lifecycles

```mermaid
stateDiagram-v2
  direction LR
  [*] --> RECEIVED
  RECEIVED --> APPROVED: APPROVE
  RECEIVED --> STEP_UP_PENDING: STEP_UP
  RECEIVED --> BLOCKED: BLOCK
  STEP_UP_PENDING --> APPROVED: CONFIRM + correct OTP within 15 min
  STEP_UP_PENDING --> BLOCKED: NOT_ME (STEP_UP_DENIED, card BLOCKED)
  STEP_UP_PENDING --> BLOCKED: no answer in 15 min (STEP_UP_TIMEOUT)
  APPROVED --> [*]
  BLOCKED --> [*]
```

```mermaid
stateDiagram-v2
  direction LR
  [*] --> OPEN: fraud-suspicion block
  OPEN --> IN_REVIEW: analyst claims (locked to one analyst)
  IN_REVIEW --> CONFIRMED_FRAUD: close, comment >= 10 chars (card BLOCKED)
  IN_REVIEW --> FALSE_POSITIVE: close, amount <= limit (cardholder notified)
  IN_REVIEW --> PENDING_MANAGER_APPROVAL: FALSE_POSITIVE above INR 1,00,000
  PENDING_MANAGER_APPROVAL --> FALSE_POSITIVE: different manager approves
  PENDING_MANAGER_APPROVAL --> CONFIRMED_FRAUD: manager rejects
  CONFIRMED_FRAUD --> [*]
  FALSE_POSITIVE --> [*]
```

Step-up details: the OTP is six random digits, stored only as a SHA-256 hash, written to the application log
(`SIMULATED OTP`) and to the cardholder's simulated message inbox. A scheduled job (every 5 s, `FOR UPDATE SKIP LOCKED`, safe
on several replicas) expires pending step-ups. Wrong OTPs are counted; after `otp_max_attempts` (3) the request can no
longer be confirmed and expires.

Concurrency on alerts: claim is a conditional `UPDATE ... WHERE status = 'OPEN'`; close and manager decisions lock the row
(`SELECT ... FOR UPDATE`) and check the status. The losing request receives HTTP 409. Maker-checker compares the manager
with the stored `proposed_by` and returns 403 when they match.

## ER diagram

```mermaid
erDiagram
  customers ||--o{ cards : owns
  customers ||--o| users : "cardholder login"
  cards ||--o{ transactions : has
  merchants ||--o{ transactions : at
  transactions ||--o| step_ups : "STEP_UP"
  transactions ||--o| alerts : "fraud-suspicion block"
  transactions ||--o| model_feedback : "analyst outcome"
  config_versions ||--o{ transactions : "config_version"
  cities ||--o{ transactions : "txn_city"
  country_risk ||--o{ cities : country
  mcc_codes ||--o{ merchants : mcc

  cards { text card_id PK  text card_hash  text last4  text card_status  date expiry_date  numeric daily_limit  bool international_enabled }
  transactions { text txn_id PK  text card_id FK  timestamptz txn_ts  numeric amount  text status  text decision  text rules_decision  text ai_decision  text[] reason_codes  int rule_risk_score  jsonb features  jsonb rule_results  numeric fraud_score  jsonb top_factors  text model_status  text model_version  jsonb response }
  step_ups { bigint step_up_id PK  text txn_id FK  text otp_hash  text status  int attempts  timestamptz expires_at }
  alerts { bigint alert_id PK  text txn_id FK  text priority  text status  timestamptz sla_due_at  text claimed_by  text proposed_by  text manager_id }
  audit_events { bigint audit_id PK  text entity  text entity_id  text actor  text role  timestamptz ts  text action  text from_status  text to_status  text comment  jsonb details }
  outbox_events { bigint event_id PK  text event_type  text audience  jsonb payload  timestamptz published_at  int attempts }
  rule_config { text key PK  jsonb value  text source }
```

- `audit_events` has a trigger that rejects every UPDATE and DELETE (FR-8). Only a demo reset (TRUNCATE) clears it.
- Full card numbers are never stored: only a salted SHA-256 hash and the last 4 digits. Screens and exports show
  `XXXXXXXXXXXX1234`.
- Each decision stores the configuration version, the model version and the exact model features used (governance).

## Architecture

```mermaid
flowchart LR
  GW[Simulated card gateway<br/>replay script / perf script] -- "X-API-Key" --> NGINX
  U[Analyst / Manager / Cardholder<br/>browser] -- "HTTPS + JWT, WebSocket" --> NGINX
  NGINX[Nginx gateway<br/>reverse proxy + load balancer] --> FE[React frontend<br/>static files]
  NGINX --> API1[Node.js API replica 1]
  NGINX --> API2[Node.js API replica 2]
  API1 & API2 -- "SQL" --> PG[(PostgreSQL<br/>source of truth)]
  API1 & API2 -- "XADD / XREADGROUP" --> RS[(Redis Streams<br/>event log)]
  API1 & API2 -- "HTTP /predict, 150 ms budget" --> ML[Flask model service<br/>XGBoost + TreeSHAP]
  DATA[[data/ case-study files]] -. seed / reset .-> PG
  DATA -. train.py .-> ML
```

## Technology decisions

| Decision | Why | Alternative not chosen |
|---|---|---|
| PostgreSQL as the only source of truth | Constraints, row locks, transactions, durable audit | Redis counters for velocity: risk of loss and races |
| Synchronous decision, asynchronous notifications | Gateway needs the decision in the response; notifications must not add latency | Queue-first authorisation: more failure modes and latency |
| Card row lock for concurrency | Simple, correct, only serialises one card | Optimistic retries: harder to reason about under bursts |
| Transactional outbox + Redis Streams | No lost or phantom events; replayable; consumer groups and ACKs | Redis Pub/Sub: fire and forget, loses events while disconnected |
| Per-replica consumer groups | Every replica can notify its own sockets without a Socket.IO adapter | Shared group: each event would reach only one replica's sockets |
| Socket.IO (WebSocket only) | Rooms, reconnection, auth handshake; no sticky sessions needed | SSE: adequate one-way, but implementing both adds cost |
| Pure rules/feature engine | Same code for API, batch and tests; easy to explain and change | Rules embedded in SQL or a rules engine product |
| XGBoost + TreeSHAP | Strong on tabular data, exact fast explanations, small artifact | LogisticRegression (team spec fallback): simpler but weaker; LLM scoring: slow and unreproducible |
| Model can only tighten | Case study guardrail; rules stay the safety floor | Model-only decisions |
| JWT in sessionStorage | Each browser tab can be a different demo user (analyst and cardholder side by side) | Cookies: shared across tabs |

## API documentation

OpenAPI 3: `GET /api/openapi.json`, Swagger UI at `/api/docs` (source `backend/src/openapi.js`). Summary: [docs/API.md](../../docs/API.md).

## Assumptions

See [IMPLEMENTATION_PLAN.md](../../IMPLEMENTATION_PLAN.md#assumptions-and-interpretations).
