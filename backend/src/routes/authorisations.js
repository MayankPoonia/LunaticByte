// POST /api/v1/authorisations: the gateway-only authorisation API (FR-2).
const express = require('express');
const { requireGateway } = require('../middleware/auth');
const { validateTransaction } = require('../validation');
const { authorise } = require('../services/authorise');

const router = express.Router();

router.post('/authorisations', requireGateway, async (req, res) => {
  const txn = validateTransaction(req.body);
  const { response, duplicate } = await authorise(txn, { source: 'API', actor: req.actor });
  res.set('Idempotent-Replay', duplicate ? 'true' : 'false');
  res.status(duplicate ? 200 : 201).json(response);
});

module.exports = router;
