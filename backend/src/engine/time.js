// Time helpers. All business dates and hours are in IST (+05:30), as the case study requires.
const IST_OFFSET_MS = 330 * 60 * 1000;
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function istDate(ms) {
  return new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 10);
}

function istMinuteOfDay(ms) {
  const d = new Date(ms + IST_OFFSET_MS);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

function istHour(ms) {
  return new Date(ms + IST_OFFSET_MS).getUTCHours();
}

// 2026-03-04T14:05:00+05:30
function toIstIso(ms) {
  return new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 19) + '+05:30';
}

// 2026-03-04T14:05:00.123+05:30 (millisecond precision, used for "now" in the simulator so
// rapid sequential transactions get distinct, strictly increasing timestamps)
function toIstIsoMs(ms) {
  return new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 23) + '+05:30';
}

// Whole days between two YYYY-MM-DD dates (b - a).
function daysBetween(a, b) {
  return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / DAY);
}

module.exports = { IST_OFFSET_MS, MINUTE, HOUR, DAY, istDate, istMinuteOfDay, istHour, toIstIso, toIstIsoMs, daysBetween };
