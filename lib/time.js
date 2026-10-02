// Sydney time (Australia/Sydney) for every day, week and month the site counts.
// Daylight saving is handled by the built-in time-zone data (Intl).
export const TIME_ZONE = "Australia/Sydney";

// The calendar date and time in Sydney for a moment in time. weekday: 0 = Monday.
export function sydneyParts(date = new Date()) {
  const p = {};
  new Intl.DateTimeFormat("en-AU", { timeZone: TIME_ZONE, year: "numeric", month: "numeric", day: "numeric",
    hour: "numeric", minute: "numeric", second: "numeric", hourCycle: "h23" })
    .formatToParts(date).forEach(x => { p[x.type] = Number(x.value); });
  const weekday = (new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay() + 6) % 7;
  return { y: p.year, m: p.month, d: p.day, h: p.hour % 24, min: p.minute, s: p.second, weekday };
}

// The moment it's midnight in Sydney at the start of a calendar date.
export function sydneyMidnight(y, m, d) {
  const wall = Date.UTC(y, m - 1, d);
  const offset = t => {
    const p = sydneyParts(new Date(t));
    return Date.UTC(p.y, p.m - 1, p.d, p.h, p.min, p.s) - Math.floor(t / 1000) * 1000;
  };
  const guess = wall - offset(wall);
  return new Date(wall - offset(guess));
}

// Start of the current day, week (Monday) or month in Sydney.
export function periodStart(period, now = new Date()) {
  const p = sydneyParts(now);
  const back = period === "month" ? p.d - 1 : period === "week" ? p.weekday : 0;
  const dt = new Date(Date.UTC(p.y, p.m - 1, p.d - back));
  return sydneyMidnight(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}

// Start of the next day, week or month in Sydney.
export function nextPeriodStart(period, now = new Date()) {
  const p = sydneyParts(periodStart(period, now));
  const dt = new Date(Date.UTC(p.y, p.m - 1 + (period === "month" ? 1 : 0), p.d + (period === "week" ? 7 : period === "day" ? 1 : 0)));
  return sydneyMidnight(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}

export const niceDate = d => d.toLocaleDateString("en-AU", { weekday: "short", day: "numeric", month: "short", timeZone: TIME_ZONE });
