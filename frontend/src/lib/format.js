// Display helpers. All dates are shown in IST, money in INR with Indian digit grouping.
const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 2 });
const dt = new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });

export const money = (v) => (v === null || v === undefined || v === '' ? '-' : inr.format(Number(v)));
export const dateTime = (v) => (v ? `${dt.format(new Date(v))} IST` : '-');
export const pct = (v, d = 1) => (v === null || v === undefined ? '-' : `${(Number(v) * 100).toFixed(d)}%`);
export const num = (v, d = 2) => (v === null || v === undefined ? '-' : Number(v).toFixed(d));
export const ms = (v) => (v === null || v === undefined ? '-' : `${Number(v).toFixed(0)} ms`);

export function relative(v) {
  const diff = new Date(v).getTime() - Date.now();
  const mins = Math.round(Math.abs(diff) / 60000);
  const text = mins < 60 ? `${mins} min` : `${Math.floor(mins / 60)} h ${mins % 60} min`;
  return diff >= 0 ? `in ${text}` : `${text} ago`;
}

export const REASON_LABELS = {
  CARD_NOT_ACTIVE: 'Card not active',
  INTL_NOT_ENABLED: 'International use not enabled',
  MERCHANT_BLACKLISTED: 'Blacklisted merchant',
  DAILY_LIMIT_EXCEEDED: 'Daily limit exceeded',
  VELOCITY_BURST: 'Velocity burst',
  IMPOSSIBLE_TRAVEL: 'Impossible travel',
  HIGH_VELOCITY: 'High velocity',
  AMOUNT_SPIKE: 'Amount spike',
  HIGH_RISK_GEO: 'High-risk geography',
  HIGH_RISK_MCC: 'High-risk merchant category',
  ODD_HOUR_HIGH_VALUE: 'Odd hour, high value',
  NEW_MERCHANT_HIGH_VALUE: 'New merchant, high value',
  MULTIPLE_RED_FLAGS: 'Multiple red flags',
  STEP_UP_DENIED: 'Cardholder denied',
  STEP_UP_TIMEOUT: 'Step-up timed out',
  HIGH_FRAUD_SCORE_MODEL: 'High model fraud score',
};
