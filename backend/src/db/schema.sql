-- FraudShield schema. Idempotent: safe to run on every start.
-- Money is NUMERIC(12,2); timestamps are TIMESTAMPTZ.

CREATE TABLE IF NOT EXISTS customers (
  customer_id TEXT PRIMARY KEY,
  full_name   TEXT NOT NULL,
  mobile      TEXT,
  email       TEXT,
  city        TEXT,
  username    TEXT UNIQUE
);

CREATE TABLE IF NOT EXISTS users (
  user_id       TEXT PRIMARY KEY,
  username      TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('CARDHOLDER', 'ANALYST', 'MANAGER')),
  display_name  TEXT NOT NULL,
  customer_id   TEXT REFERENCES customers(customer_id)
);

CREATE TABLE IF NOT EXISTS cities (
  city      TEXT PRIMARY KEY,
  country   TEXT NOT NULL,
  lat       DOUBLE PRECISION NOT NULL,
  lon       DOUBLE PRECISION NOT NULL,
  city_tier TEXT
);

CREATE TABLE IF NOT EXISTS country_risk (
  country_code TEXT PRIMARY KEY,
  country_name TEXT,
  risk_level   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS mcc_codes (
  mcc             TEXT PRIMARY KEY,
  mcc_description TEXT,
  mcc_category    TEXT,
  high_risk       BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE TABLE IF NOT EXISTS merchants (
  merchant_id     TEXT PRIMARY KEY,
  merchant_name   TEXT NOT NULL,
  mcc             TEXT,
  mcc_description TEXT,
  city            TEXT,
  country         TEXT,
  merchant_risk   TEXT NOT NULL
);

-- Only a salted hash and the last 4 digits of the card number are stored.
CREATE TABLE IF NOT EXISTS cards (
  card_id               TEXT PRIMARY KEY,
  customer_id           TEXT REFERENCES customers(customer_id),
  card_hash             TEXT NOT NULL,
  last4                 TEXT NOT NULL,
  card_type             TEXT NOT NULL,
  card_status           TEXT NOT NULL,
  issue_date            DATE,
  expiry_date           DATE NOT NULL,
  home_city             TEXT,
  home_country          TEXT,
  daily_limit           NUMERIC(12,2) NOT NULL,
  international_enabled BOOLEAN NOT NULL,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS cards_customer_idx ON cards (customer_id);

CREATE TABLE IF NOT EXISTS transactions (
  txn_id           TEXT PRIMARY KEY,
  card_id          TEXT NOT NULL REFERENCES cards(card_id),
  txn_ts           TIMESTAMPTZ NOT NULL,
  amount           NUMERIC(12,2) NOT NULL,
  currency         TEXT NOT NULL DEFAULT 'INR',
  merchant_id      TEXT,
  mcc              TEXT,
  channel          TEXT NOT NULL,
  txn_city         TEXT,
  txn_country      TEXT,
  source           TEXT NOT NULL,           -- HISTORY | API | SIMULATOR | BATCH
  status           TEXT NOT NULL,           -- APPROVED | STEP_UP_PENDING | BLOCKED
  decision         TEXT,                    -- effective decision returned to the gateway
  rules_decision   TEXT,                    -- rules-only decision (decisions_output.csv)
  ai_decision      TEXT,                    -- decision after AI-2 (null when model unavailable)
  reason_codes     TEXT[] NOT NULL DEFAULT '{}',
  rule_risk_score  INTEGER,
  features         JSONB,
  rule_results     JSONB,
  fraud_score      NUMERIC(6,4),
  top_factors      JSONB,
  model_status     TEXT,
  model_version    TEXT,
  model_latency_ms NUMERIC(8,2),
  config_version   INTEGER,
  request_hash     TEXT,
  response         JSONB,
  processing_ms    NUMERIC(8,2),
  processed_at     TIMESTAMPTZ,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS transactions_card_ts_idx ON transactions (card_id, txn_ts);
CREATE INDEX IF NOT EXISTS transactions_processed_idx ON transactions (processed_at DESC) WHERE source <> 'HISTORY';

CREATE SEQUENCE IF NOT EXISTS simulated_txn_seq START 700000001;

CREATE TABLE IF NOT EXISTS step_ups (
  step_up_id  BIGSERIAL PRIMARY KEY,
  txn_id      TEXT UNIQUE NOT NULL REFERENCES transactions(txn_id),
  card_id     TEXT NOT NULL,
  customer_id TEXT,
  otp_hash    TEXT NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('PENDING', 'CONFIRMED', 'DENIED', 'EXPIRED')),
  attempts    INTEGER NOT NULL DEFAULT 0,
  expires_at  TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS step_ups_pending_idx ON step_ups (expires_at) WHERE status = 'PENDING';

CREATE TABLE IF NOT EXISTS alerts (
  alert_id        BIGSERIAL PRIMARY KEY,
  txn_id          TEXT UNIQUE NOT NULL REFERENCES transactions(txn_id),
  card_id         TEXT NOT NULL,
  priority        TEXT NOT NULL CHECK (priority IN ('HIGH', 'MEDIUM')),
  status          TEXT NOT NULL CHECK (status IN ('OPEN', 'IN_REVIEW', 'PENDING_MANAGER_APPROVAL', 'CONFIRMED_FRAUD', 'FALSE_POSITIVE')),
  reason_codes    TEXT[] NOT NULL,
  amount          NUMERIC(12,2) NOT NULL,
  fraud_score     NUMERIC(6,4),
  sla_due_at      TIMESTAMPTZ NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL,
  claimed_by      TEXT,
  claimed_at      TIMESTAMPTZ,
  proposed_by     TEXT,
  proposed_at     TIMESTAMPTZ,
  analyst_comment TEXT,
  manager_id      TEXT,
  manager_comment TEXT,
  closed_at       TIMESTAMPTZ,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS alerts_queue_idx ON alerts (status, priority, sla_due_at);

CREATE TABLE IF NOT EXISTS rule_config (
  key         TEXT PRIMARY KEY,
  value       JSONB NOT NULL,
  source      TEXT NOT NULL,         -- file | default | user
  description TEXT,
  updated_by  TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS config_versions (
  version    SERIAL PRIMARY KEY,
  changed_by TEXT NOT NULL,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  snapshot   JSONB NOT NULL
);

-- Append-only audit trail (FR-8). The trigger below rejects UPDATE and DELETE.
CREATE TABLE IF NOT EXISTS audit_events (
  audit_id    BIGSERIAL PRIMARY KEY,
  entity      TEXT NOT NULL,          -- TRANSACTION | ALERT | CARD | CONFIG | STEP_UP
  entity_id   TEXT NOT NULL,
  actor       TEXT NOT NULL,
  role        TEXT NOT NULL,
  ts          TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  action      TEXT NOT NULL,
  from_status TEXT,
  to_status   TEXT,
  comment     TEXT,
  details     JSONB
);
CREATE INDEX IF NOT EXISTS audit_entity_idx ON audit_events (entity, entity_id, audit_id);

CREATE OR REPLACE FUNCTION audit_events_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_events_no_update ON audit_events;
CREATE TRIGGER audit_events_no_update BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION audit_events_append_only();

-- Transactional outbox: written in the same transaction as the state change, then published to Redis Streams.
CREATE TABLE IF NOT EXISTS outbox_events (
  event_id     BIGSERIAL PRIMARY KEY,
  event_type   TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  audience     TEXT NOT NULL,         -- staff | customer:<customer_id>
  payload      JSONB NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  published_at TIMESTAMPTZ,
  attempts     INTEGER NOT NULL DEFAULT 0,
  last_error   TEXT
);
CREATE INDEX IF NOT EXISTS outbox_unpublished_idx ON outbox_events (event_id) WHERE published_at IS NULL;

-- Simulated outbound messages (OTP SMS, false-positive notices). Nothing is actually sent.
CREATE TABLE IF NOT EXISTS notifications (
  notification_id BIGSERIAL PRIMARY KEY,
  customer_id     TEXT,
  card_id         TEXT,
  txn_id          TEXT,
  kind            TEXT NOT NULL,
  message         TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Analyst outcomes stored as feedback labels for the next training run.
CREATE TABLE IF NOT EXISTS model_feedback (
  txn_id     TEXT PRIMARY KEY,
  label      INTEGER NOT NULL,
  source     TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
