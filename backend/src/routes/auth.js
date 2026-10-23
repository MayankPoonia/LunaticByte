// Login and demo accounts. Prefilled credentials exist only in DEMO_MODE; the role always comes
// from the database row of the authenticated user, never from the client.
const express = require('express');
const bcrypt = require('bcryptjs');
const env = require('../env');
const { query } = require('../db');
const { signToken, requireUser } = require('../middleware/auth');
const { HttpError } = require('../errors');

const router = express.Router();

router.post('/auth/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (typeof username !== 'string' || typeof password !== 'string') throw new HttpError(400, 'VALIDATION_ERROR', 'username and password are required');
  const { rows } = await query('SELECT user_id, username, password_hash, role, display_name, customer_id FROM users WHERE username = $1', [username.trim()]);
  const user = rows[0];
  if (!user || !(await bcrypt.compare(password, user.password_hash))) throw new HttpError(401, 'INVALID_CREDENTIALS', 'Invalid username or password');
  const { password_hash: _ignored, ...safe } = user;
  res.json({ token: signToken(user), user: safe });
});

router.get('/auth/me', requireUser, (req, res) => res.json({ user: req.user }));

// Demo convenience for the login page role selector.
router.get('/auth/demo-accounts', async (req, res) => {
  if (!env.demoMode) return res.json({ demo_mode: false, accounts: [] });
  const staff = await query("SELECT username, role, display_name FROM users WHERE role <> 'CARDHOLDER' ORDER BY role, username");
  // Cardholders who own the worked-example cards first, then a few others; each lists the cards it owns.
  const holders = await query(
    `SELECT u.username, u.role, u.display_name, array_agg(c.card_id ORDER BY c.card_id) AS cards
     FROM users u JOIN cards c ON c.customer_id = u.customer_id
     WHERE u.role = 'CARDHOLDER' GROUP BY u.username, u.role, u.display_name
     ORDER BY min(c.card_id) LIMIT 12`);
  const span = (cards) => (cards.length > 2 ? `${cards[0]}-${cards[cards.length - 1]}` : cards.join(', '));
  const cardholders = holders.rows.map((h) => ({ ...h, card_id: h.cards[0], display_name: `${h.display_name} (card${h.cards.length > 1 ? 's' : ''} ${span(h.cards)})` }));
  res.json({ demo_mode: true, password: env.demoPassword, accounts: [...staff.rows, ...cardholders] });
});

module.exports = router;
