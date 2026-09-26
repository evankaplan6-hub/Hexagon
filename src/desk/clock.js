'use strict';
// The US stock market's calendar, in Eastern time: which days it trades, when it opens and closes,
// and the few afternoons it closes at 1 PM. Crypto never closes and needs none of this.
//
// Everything here is pure (an instant or a date in, an answer out), so tools/desk-test.js can pin
// it without a clock or a timezone-sensitive machine.
//
// The holiday lists are NYSE's own, copied from the investment stack's trend-day checker
// (strategies/scripts/trend_day_check.py), which is where the options book's rules come from. They
// end with 2027. A date past the last listed year still answers, as a plain weekday, and
// calendarCovers() says so, so TESS can raise it before a holiday is traded through.

const HOLIDAYS = new Set([
  '2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03', '2026-05-25', '2026-06-19', '2026-07-03', '2026-09-07', '2026-11-26', '2026-12-25',
  '2027-01-01', '2027-01-18', '2027-02-15', '2027-03-26', '2027-05-31', '2027-06-18', '2027-07-05', '2027-09-06', '2027-11-25', '2027-12-24',
]);
// 1 PM closes. SPY's same-day options stop trading at 1 PM on these days too.
const EARLY_CLOSE = new Set(['2026-11-27', '2026-12-24', '2027-11-26']);
const LAST_YEAR = 2027;

const OPEN_MIN = 9 * 60 + 30;
const CLOSE_MIN = 16 * 60;
const EARLY_CLOSE_MIN = 13 * 60;

const FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', hourCycle: 'h23', weekday: 'short',
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
});
const WD = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

// An instant -> its Eastern date and time: { day: 'YYYY-MM-DD', min (minutes since midnight), sec, wd (0 = Sunday) }.
function et(t) {
  const p = Object.fromEntries(FMT.formatToParts(new Date(t)).map((x) => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, min: (+p.hour) * 60 + (+p.minute), sec: +p.second, wd: WD[p.weekday] };
}

// An Eastern wall-clock time with no offset ('2026-09-25T09:31:00', as Cboe writes its bars) -> the
// instant. Eastern is UTC-4 or UTC-5 depending on the date, so try both and keep the one that reads
// back as the same wall time. An hour that does not exist (the spring-forward gap) is null.
function etToUtc(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/.exec(String(s || ''));
  if (!m) return null;
  const [, y, mo, d, h, mi, se] = m;
  const wall = Date.UTC(+y, +mo - 1, +d, +h, +mi, +(se || 0));
  for (const off of [4, 5]) {
    const t = wall + off * 3600000, p = et(t);
    if (p.day === `${y}-${mo}-${d}` && p.min === (+h) * 60 + (+mi)) return t;
  }
  return null;
}

// A date and a time in minutes since midnight Eastern -> the instant ('2026-09-23', 755 is 12:35 PM
// Eastern that day). Bars carry their minute, not their instant.
const atMin = (day, min) => etToUtc(`${day}T${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}:00`);

// A 'YYYY-MM-DD' -> weekday, by the calendar rather than a clock.
const weekday = (day) => new Date(`${day}T12:00:00Z`).getUTCDay();
const addDays = (day, n) => new Date(Date.parse(`${day}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

function isTradingDay(day) {
  const wd = weekday(day);
  return wd >= 1 && wd <= 5 && !HOLIDAYS.has(day);
}
// The regular session on a date in minutes since midnight Eastern, or null on a closed day.
function session(day) {
  if (!isTradingDay(day)) return null;
  return { open: OPEN_MIN, close: EARLY_CLOSE.has(day) ? EARLY_CLOSE_MIN : CLOSE_MIN, early: EARLY_CLOSE.has(day) };
}
const isEarlyClose = (day) => EARLY_CLOSE.has(day);
const calendarCovers = (day) => +String(day).slice(0, 4) <= LAST_YEAR;

// Is the regular session open at instant t?
function isOpen(t) {
  const p = et(t), s = session(p.day);
  return !!s && p.min >= s.open && p.min < s.close;
}

// The trading day before `day` (skipping weekends and holidays).
function prevTradingDay(day) {
  let d = addDays(day, -1);
  for (let i = 0; i < 10 && !isTradingDay(d); i++) d = addDays(d, -1);
  return d;
}

// When the market next opens after instant t, as { day, at } -- `at` the instant of 9:30 Eastern.
function nextOpen(t) {
  const p = et(t);
  let day = p.day;
  const s = session(day);
  if (!s || p.min >= s.open) day = addDays(day, 1);
  for (let i = 0; i < 10 && !isTradingDay(day); i++) day = addDays(day, 1);
  return { day, at: etToUtc(`${day}T09:30:00`) };
}

// One line a person reads: "open until 4:00 PM ET" or "opens Mon 9:30 AM ET".
function describe(t) {
  const p = et(t), s = session(p.day);
  if (s && p.min >= s.open && p.min < s.close) return `open until ${s.early ? '1:00' : '4:00'} PM ET`;
  const n = nextOpen(t);
  const name = n.day === p.day ? 'today' : n.day === addDays(p.day, 1) ? 'tomorrow' : ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][weekday(n.day)];
  return `opens ${name} 9:30 AM ET`;
}

module.exports = {
  et, etToUtc, atMin, isTradingDay, session, isOpen, isEarlyClose, calendarCovers, prevTradingDay, nextOpen, describe, addDays,
  OPEN_MIN, CLOSE_MIN, LAST_YEAR,
};
