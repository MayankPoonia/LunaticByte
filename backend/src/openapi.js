// OpenAPI 3 description of the FraudShield API, served at /api/openapi.json and /api/docs (Swagger UI).
const ref = (name) => ({ $ref: `#/components/schemas/${name}` });
const json = (schema, description = 'OK') => ({ description, content: { 'application/json': { schema } } });
const err = (description) => json(ref('Error'), description);
const body = (schema, required = true) => ({ required, content: { 'application/json': { schema } } });
const idParam = (name, description) => ({ name, in: 'path', required: true, schema: { type: 'string' }, description });
const staff = [{ bearerAuth: [] }];
const simulatorAuth = [{}, { bearerAuth: [] }]; // open in DEMO_MODE, staff token otherwise
const STD = { 401: err('Missing or invalid credentials'), 403: err('Authenticated but the role is not allowed') };

const transactionInput = {
  type: 'object',
  required: ['txn_id', 'card_id', 'txn_ts', 'amount', 'currency', 'merchant_id', 'mcc', 'channel', 'txn_city', 'txn_country'],
  properties: {
    txn_id: { type: 'string', pattern: '^T[0-9]{9}$', example: 'T200000001' },
    card_id: { type: 'string', example: 'C1001' },
    txn_ts: { type: 'string', description: 'ISO-8601 with +05:30 offset', example: '2026-03-04T14:05:00+05:30' },
    amount: { type: 'string', description: 'Greater than 0 and at most 1000000.00, 2 decimals (number also accepted)', example: '3500.00' },
    currency: { type: 'string', enum: ['INR'] },
    merchant_id: { type: 'string', example: 'M00450' },
    mcc: { type: 'string', pattern: '^\\d{4}$', example: '5411' },
    channel: { type: 'string', enum: ['POS', 'ECOM', 'ATM', 'CONTACTLESS'] },
    txn_city: { type: 'string', description: 'Must exist in the cities reference data', example: 'Mumbai' },
    txn_country: { type: 'string', description: 'Must be the country of txn_city', example: 'IN' },
  },
};

module.exports = {
  openapi: '3.0.3',
  info: {
    title: 'FraudShield API',
    version: '1.0.0',
    description: 'Real-time card authorisation, step-up verification, alert management and audit for Kaveri National Bank (hackathon prototype).\n\n'
      + 'Authentication: the authorisation endpoint accepts only the gateway service key (`X-API-Key`). All other endpoints need a '
      + 'Bearer token from `POST /api/v1/auth/login`; roles are enforced on the server.\n\n'
      + 'Idempotency: a repeated `txn_id` with the same payload returns the original response (HTTP 200, header `Idempotent-Replay: true`) '
      + 'and creates no new transaction, alert or audit record. The same `txn_id` with a different payload returns 409.',
  },
  servers: [{ url: '/' }],
  tags: [
    { name: 'Gateway' }, { name: 'Auth' }, { name: 'Simulator' }, { name: 'Transactions' }, { name: 'Alerts' }, { name: 'Cardholder' },
    { name: 'Dashboard and audit' }, { name: 'Configuration' }, { name: 'Model' }, { name: 'Demo and testing' }, { name: 'Health' },
  ],
  components: {
    securitySchemes: {
      gatewayKey: { type: 'apiKey', in: 'header', name: 'X-API-Key' },
      bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
    },
    schemas: {
      Error: {
        type: 'object',
        properties: {
          error: { type: 'string', example: 'VALIDATION_ERROR' },
          message: { type: 'string' },
          fields: { type: 'array', items: { type: 'object', properties: { field: { type: 'string' }, message: { type: 'string' } } } },
        },
      },
      TransactionInput: transactionInput,
      TopFactor: {
        type: 'object',
        properties: {
          feature: { type: 'string', example: 'amount_to_avg30_ratio' }, value: {}, contribution: { type: 'number' },
          direction: { type: 'string', enum: ['raises', 'lowers'] }, text: { type: 'string', example: "amount 18.8x the card's 30-day average" },
        },
      },
      AuthorisationResponse: {
        type: 'object',
        properties: {
          txn_id: { type: 'string' },
          decision: { type: 'string', enum: ['APPROVE', 'STEP_UP', 'BLOCK'], description: 'Final decision (after AI-2 when the model is available)' },
          reason_codes: { type: 'array', items: { type: 'string' }, description: 'Triggered codes in rule order; HIGH_FRAUD_SCORE_MODEL appended when the model escalated' },
          rule_risk_score: { type: 'integer', nullable: true, description: 'Null after a hard stop (R1/R2)' },
          status: { type: 'string', enum: ['APPROVED', 'STEP_UP_PENDING', 'BLOCKED'] },
          alert_id: { type: 'integer', nullable: true },
          processed_at: { type: 'string', example: '2026-03-04T14:05:00+05:30' },
          fraud_score: { type: 'number', nullable: true, description: '0 to 1, 4 decimals; null when the model is unavailable' },
          top_factors: { type: 'array', items: ref('TopFactor') },
          model_status: { type: 'string', enum: ['OK', 'MODEL_UNAVAILABLE', 'DISABLED'] },
          model_version: { type: 'string', nullable: true },
          rules_decision: { type: 'string', enum: ['APPROVE', 'STEP_UP', 'BLOCK'] },
          step_up: { type: 'object', nullable: true, properties: { step_up_id: { type: 'integer' }, expires_at: { type: 'string', format: 'date-time' } } },
          features: {
            type: 'object',
            properties: {
              velocity_10m: { type: 'integer' }, approved_today: { type: 'number' }, avg_amount_30d: { type: 'number', nullable: true },
              speed_kmph: { type: 'number', nullable: true }, new_merchant: { type: 'boolean' },
            },
          },
          model_latency_ms: { type: 'number', nullable: true },
          processing_ms: { type: 'number' },
        },
      },
      Alert: {
        type: 'object',
        properties: {
          alert_id: { type: 'integer' }, txn_id: { type: 'string' }, card_id: { type: 'string' }, card_last4: { type: 'string' },
          priority: { type: 'string', enum: ['HIGH', 'MEDIUM'] },
          status: { type: 'string', enum: ['OPEN', 'IN_REVIEW', 'PENDING_MANAGER_APPROVAL', 'CONFIRMED_FRAUD', 'FALSE_POSITIVE'] },
          reason_codes: { type: 'array', items: { type: 'string' } }, amount: { type: 'string' }, fraud_score: { type: 'number', nullable: true },
          sla_due_at: { type: 'string', format: 'date-time' }, sla_breached: { type: 'boolean' }, claimed_by: { type: 'string', nullable: true },
        },
      },
      AuditEvent: {
        type: 'object',
        properties: {
          audit_id: { type: 'integer' }, entity: { type: 'string' }, entity_id: { type: 'string' }, actor: { type: 'string' }, role: { type: 'string' },
          ts: { type: 'string', format: 'date-time' }, action: { type: 'string' }, from_status: { type: 'string', nullable: true },
          to_status: { type: 'string', nullable: true }, comment: { type: 'string', nullable: true }, details: { type: 'object', nullable: true },
        },
      },
    },
  },
  paths: {
    '/api/v1/authorisations': {
      post: {
        tags: ['Gateway'], summary: 'Authorise a card transaction (FR-2)', security: [{ gatewayKey: [] }],
        requestBody: body(ref('TransactionInput')),
        responses: {
          201: json(ref('AuthorisationResponse'), 'New decision'),
          200: json(ref('AuthorisationResponse'), 'Idempotent replay of the original decision'),
          400: err('Body is not a JSON object / invalid JSON'), 401: err('Missing or invalid X-API-Key'),
          409: err('txn_id already used for a different payload'), 422: err('Invalid fields (listed in fields[])'),
        },
      },
    },
    '/api/v1/auth/login': {
      post: {
        tags: ['Auth'], summary: 'Sign in and receive a JWT',
        requestBody: body({ type: 'object', required: ['username', 'password'], properties: { username: { type: 'string', example: 'analyst1' }, password: { type: 'string', example: 'Demo@123' } } }),
        responses: { 200: json({ type: 'object', properties: { token: { type: 'string' }, user: { type: 'object' } } }), 401: err('Invalid credentials') },
      },
    },
    '/api/v1/auth/me': { get: { tags: ['Auth'], summary: 'Current user from the token', security: staff, responses: { 200: json({ type: 'object' }), 401: STD[401] } } },
    '/api/v1/auth/demo-accounts': { get: { tags: ['Auth'], summary: 'Seeded demo accounts for the login role selector (DEMO_MODE only)', responses: { 200: json({ type: 'object' }) } } },
    '/api/v1/simulator/options': { get: { tags: ['Simulator'], summary: 'Cards, merchants, cities and channels for the simulator form', security: simulatorAuth, responses: { 200: json({ type: 'object' }), ...STD } } },
    '/api/v1/simulator/scenarios': { get: { tags: ['Simulator'], summary: 'Predefined demo scenarios (from the sample batch file)', security: simulatorAuth, responses: { 200: json({ type: 'object' }), ...STD } } },
    '/api/v1/simulator/next-id': { get: { tags: ['Simulator'], summary: 'Reserve a fresh transaction id', security: simulatorAuth, responses: { 200: json({ type: 'object', properties: { txn_id: { type: 'string' } } }), ...STD } } },
    '/api/v1/simulator/transactions': {
      post: {
        tags: ['Simulator'], summary: 'Submit a transaction through the same authorisation service (no gateway key in the browser)', security: simulatorAuth,
        description: 'Same fields as /authorisations; txn_id is optional (a sequence id is assigned) and txn_ts may be "now". Open in DEMO_MODE (standalone /simulator page); otherwise needs an analyst or manager token.',
        requestBody: body({ ...transactionInput, required: ['card_id', 'amount', 'currency', 'merchant_id', 'mcc', 'channel', 'txn_city', 'txn_country'] }),
        responses: { 201: json(ref('AuthorisationResponse')), 200: json(ref('AuthorisationResponse'), 'Idempotent replay'), 409: err('Idempotency conflict'), 422: err('Invalid fields'), ...STD },
      },
    },
    '/api/v1/transactions': {
      get: {
        tags: ['Transactions'], summary: 'List transactions (analyst, manager)', security: staff,
        parameters: [
          { name: 'source', in: 'query', schema: { type: 'string', enum: ['live', 'all', 'API', 'SIMULATOR', 'BATCH', 'HISTORY'] } },
          { name: 'status', in: 'query', schema: { type: 'string' } }, { name: 'decision', in: 'query', schema: { type: 'string' } },
          { name: 'card_id', in: 'query', schema: { type: 'string' } }, { name: 'q', in: 'query', schema: { type: 'string' } },
          { name: 'limit', in: 'query', schema: { type: 'integer', maximum: 500 } },
        ],
        responses: { 200: json({ type: 'object' }), ...STD },
      },
    },
    '/api/v1/transactions/{id}': { get: { tags: ['Transactions'], summary: 'Transaction with rule evaluation, features, model score, step-up, alert and audit', security: staff, parameters: [idParam('id', 'txn_id')], responses: { 200: json({ type: 'object' }), 404: err('Not found'), ...STD } } },
    '/api/v1/cards/{id}': { get: { tags: ['Transactions'], summary: 'Card profile (masked) and recent transactions', security: staff, parameters: [idParam('id', 'card_id')], responses: { 200: json({ type: 'object' }), 404: err('Not found'), ...STD } } },
    '/api/v1/alerts': {
      get: {
        tags: ['Alerts'], summary: 'Alert queue ordered by priority then sla_due_at', security: staff,
        parameters: [{ name: 'status', in: 'query', schema: { type: 'string', description: 'active (default), closed, all, or a status' } }, { name: 'priority', in: 'query', schema: { type: 'string', enum: ['HIGH', 'MEDIUM'] } }],
        responses: { 200: json({ type: 'object', properties: { alerts: { type: 'array', items: ref('Alert') } } }), ...STD },
      },
    },
    '/api/v1/alerts/{id}': { get: { tags: ['Alerts'], summary: 'Alert investigation view (transaction, features, rules, score, card history)', security: staff, parameters: [idParam('id', 'alert_id')], responses: { 200: json({ type: 'object' }), 404: err('Not found'), ...STD } } },
    '/api/v1/alerts/{id}/claim': { post: { tags: ['Alerts'], summary: 'Claim an OPEN alert (analyst); locks it to the caller', security: staff, parameters: [idParam('id', 'alert_id')], responses: { 200: json(ref('Alert')), 404: err('Not found'), 409: err('Already claimed or not OPEN'), ...STD } } },
    '/api/v1/alerts/{id}/close': {
      post: {
        tags: ['Alerts'], summary: 'Close a claimed alert (claiming analyst only)', security: staff, parameters: [idParam('id', 'alert_id')],
        description: 'FALSE_POSITIVE on an amount above the maker-checker limit moves the alert to PENDING_MANAGER_APPROVAL. CONFIRMED_FRAUD blocks the card.',
        requestBody: body({ type: 'object', required: ['outcome', 'comment'], properties: { outcome: { type: 'string', enum: ['CONFIRMED_FRAUD', 'FALSE_POSITIVE'] }, comment: { type: 'string', minLength: 10 } } }),
        responses: { 200: json({ type: 'object' }), 409: err('Not IN_REVIEW or claimed by someone else'), 422: err('Invalid outcome or comment shorter than 10 characters'), ...STD },
      },
    },
    '/api/v1/alerts/{id}/manager-decision': {
      post: {
        tags: ['Alerts'], summary: 'Approve or reject a FALSE_POSITIVE proposal (manager; maker and checker must differ)', security: staff, parameters: [idParam('id', 'alert_id')],
        requestBody: body({ type: 'object', required: ['decision', 'comment'], properties: { decision: { type: 'string', enum: ['APPROVE', 'REJECT'] }, comment: { type: 'string', minLength: 10 } } }),
        responses: { 200: json({ type: 'object' }), 403: err('Not a manager, or the caller proposed it (MAKER_CHECKER_VIOLATION)'), 409: err('Not PENDING_MANAGER_APPROVAL'), 422: err('Invalid input'), 401: STD[401] },
      },
    },
    '/api/v1/me/cards': { get: { tags: ['Cardholder'], summary: 'Own cards (masked)', security: staff, responses: { 200: json({ type: 'object' }), ...STD } } },
    '/api/v1/me/cards/{id}/block': { post: { tags: ['Cardholder'], summary: 'Block own card', security: staff, parameters: [idParam('id', 'card_id')], responses: { 200: json({ type: 'object' }), 404: err('Not your card'), ...STD } } },
    '/api/v1/me/transactions': { get: { tags: ['Cardholder'], summary: 'Own transactions with plain-language messages (no codes or scores)', security: staff, responses: { 200: json({ type: 'object' }), ...STD } } },
    '/api/v1/me/transactions/{id}': { get: { tags: ['Cardholder'], summary: 'One own transaction', security: staff, parameters: [idParam('id', 'txn_id')], responses: { 200: json({ type: 'object' }), 404: err('Not found or not yours'), ...STD } } },
    '/api/v1/me/step-ups': { get: { tags: ['Cardholder'], summary: 'Own step-up requests', security: staff, responses: { 200: json({ type: 'object' }), ...STD } } },
    '/api/v1/me/step-ups/{id}/respond': {
      post: {
        tags: ['Cardholder'], summary: 'Answer "Was this you?" (CONFIRM with OTP, or NOT_ME)', security: staff, parameters: [idParam('id', 'step_up_id')],
        requestBody: body({ type: 'object', required: ['response'], properties: { response: { type: 'string', enum: ['CONFIRM', 'NOT_ME'] }, otp: { type: 'string', pattern: '^\\d{6}$' } } }),
        responses: {
          200: json({ type: 'object' }), 404: err('Not found or not yours'), 409: err('Already resolved, expired (STEP_UP_EXPIRED) or too many attempts'),
          422: err('Invalid response or wrong OTP (INVALID_OTP, attempts left in details)'), ...STD,
        },
      },
    },
    '/api/v1/me/notifications': { get: { tags: ['Cardholder'], summary: 'Simulated SMS inbox (OTP messages, false-positive notices)', security: staff, responses: { 200: json({ type: 'object' }), ...STD } } },
    '/api/v1/dashboard/summary': {
      get: {
        tags: ['Dashboard and audit'], summary: 'Fraud dashboard figures (FR-9)', security: staff,
        parameters: [{ name: 'from', in: 'query', schema: { type: 'string', format: 'date' } }, { name: 'to', in: 'query', schema: { type: 'string', format: 'date' } }],
        responses: { 200: json({ type: 'object' }), ...STD },
      },
    },
    '/api/v1/audit': { get: { tags: ['Dashboard and audit'], summary: 'Recent audit events', security: staff, parameters: [{ name: 'entity', in: 'query', schema: { type: 'string' } }, { name: 'limit', in: 'query', schema: { type: 'integer' } }], responses: { 200: json({ type: 'object', properties: { events: { type: 'array', items: ref('AuditEvent') } } }), ...STD } } },
    '/api/v1/audit/{entity}/{id}': {
      get: {
        tags: ['Dashboard and audit'], summary: 'Ordered audit history of a transaction, alert, card, step-up or config key (format=csv to export)', security: staff,
        parameters: [{ name: 'entity', in: 'path', required: true, schema: { type: 'string', enum: ['TRANSACTION', 'ALERT', 'CARD', 'CONFIG', 'STEP_UP'] } }, idParam('id', 'Entity id'), { name: 'format', in: 'query', schema: { type: 'string', enum: ['json', 'csv'] } }],
        responses: { 200: json({ type: 'object' }), 400: err('Unknown entity'), ...STD },
      },
    },
    '/api/v1/config': { get: { tags: ['Configuration'], summary: 'All rule parameters with source and versions', security: staff, responses: { 200: json({ type: 'object' }), ...STD } } },
    '/api/v1/config/{key}': {
      put: {
        tags: ['Configuration'], summary: 'Change one parameter (manager); new version + audit with before/after', security: staff, parameters: [idParam('key', 'Parameter key, e.g. velocity_burst_count')],
        requestBody: body({ type: 'object', required: ['value'], properties: { value: {}, comment: { type: 'string' } } }),
        responses: { 200: json({ type: 'object' }), 422: err('Invalid value for this parameter'), ...STD },
      },
    },
    '/api/v1/model/info': { get: { tags: ['Model'], summary: 'Model version, evaluation metrics and rules-missed examples (proxied from the model service)', security: staff, responses: { 200: json({ type: 'object' }), 503: err('Model service unavailable'), ...STD } } },
    '/api/v1/model/score': { post: { tags: ['Model'], summary: 'Score a feature vector with the live model (explorer)', security: staff, requestBody: body({ type: 'object', properties: { features: { type: 'object' } } }), responses: { 200: json({ type: 'object' }), 422: err('Invalid features'), 503: err('Model unavailable'), ...STD } } },
    '/api/v1/demo/reset': { post: { tags: ['Demo and testing'], summary: 'Reload the data pack and wipe dynamic state (manager, DEMO_MODE)', security: staff, requestBody: body({ type: 'object', properties: { confirm: { type: 'string', enum: ['RESET'] } } }), responses: { 200: json({ type: 'object' }), 422: err('Confirmation missing'), ...STD } } },
    '/api/v1/demo/step-ups/{id}/expire': { post: { tags: ['Demo and testing'], summary: 'Make a pending step-up due now and run the expiry job (manager, DEMO_MODE)', security: staff, parameters: [idParam('id', 'step_up_id')], responses: { 200: json({ type: 'object' }), 409: err('Not pending'), ...STD } } },
    '/api/v1/test-runner/categories': { get: { tags: ['Demo and testing'], summary: 'Automated test categories (manager)', security: staff, responses: { 200: json({ type: 'object' }), ...STD } } },
    '/api/v1/test-runner/run': { post: { tags: ['Demo and testing'], summary: 'Run one test category against the isolated test database (manager)', security: staff, requestBody: body({ type: 'object', properties: { category: { type: 'string', example: 'B' } } }), responses: { 200: json({ type: 'object' }), 409: err('Another run in progress'), ...STD } } },
    '/api/v1/system/status': { get: { tags: ['Health'], summary: 'Instance, data pack, model health, outbox backlog and event delivery latency', security: staff, responses: { 200: json({ type: 'object' }), ...STD } } },
    '/health': { get: { tags: ['Health'], summary: 'Liveness', responses: { 200: json({ type: 'object' }) } } },
    '/ready': { get: { tags: ['Health'], summary: 'Readiness (database required; Redis and model reported)', responses: { 200: json({ type: 'object' }), 503: json({ type: 'object' }, 'Database unavailable') } } },
  },
};
