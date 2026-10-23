// Authentication and role-based authorisation, enforced on the server for every route.
//   - Gateway (simulated card network): X-API-Key header, only for POST /api/v1/authorisations.
//   - People (cardholder, analyst, manager): JWT bearer token from POST /api/v1/auth/login.
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const env = require('../env');

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function requireGateway(req, res, next) {
  const key = req.get('x-api-key');
  if (!key || !safeEqual(key, env.gatewayApiKey)) {
    return res.status(401).json({ error: 'UNAUTHORIZED', message: 'Valid X-API-Key header required' });
  }
  req.actor = { id: 'gateway', role: 'GATEWAY' };
  return next();
}

function signToken(user) {
  return jwt.sign(
    { sub: user.user_id, role: user.role, customer_id: user.customer_id || null, name: user.display_name, username: user.username },
    env.jwtSecret, { expiresIn: env.jwtTtl },
  );
}

function verifyToken(token) {
  const c = jwt.verify(token, env.jwtSecret);
  return { user_id: c.sub, role: c.role, customer_id: c.customer_id, display_name: c.name, username: c.username };
}

function requireUser(req, res, next) {
  const header = req.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'UNAUTHORIZED', message: 'Bearer token required' });
  try {
    req.user = verifyToken(token);
    return next();
  } catch {
    return res.status(401).json({ error: 'UNAUTHORIZED', message: 'Invalid or expired token' });
  }
}

const requireRole = (...roles) => (req, res, next) => {
  if (!req.user || !roles.includes(req.user.role)) {
    return res.status(403).json({ error: 'FORBIDDEN', message: `Requires role ${roles.join(' or ')}` });
  }
  return next();
};

const STAFF = ['ANALYST', 'MANAGER'];

module.exports = { requireGateway, requireUser, requireRole, signToken, verifyToken, STAFF };
