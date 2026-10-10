// The shop works in Asia/Dhaka (UTC+6, no daylight saving); the database stores UTC.

const DHAKA_OFFSET = '+06:00';
const DAY_MS = 24 * 3600 * 1000;

/** Start of a Dhaka calendar day, as a UTC Date. */
const dayStart = (day) => new Date(`${day}T00:00:00${DHAKA_OFFSET}`);

/** Start of the following Dhaka day: the exclusive end of a date filter. */
const dayEnd = (day) => new Date(dayStart(day).getTime() + DAY_MS);

/** Today's date in Dhaka, "YYYY-MM-DD". */
function today() {
  return new Date(Date.now() + 6 * 3600 * 1000).toISOString().slice(0, 10);
}

/**
 * The moment to record for a document dated `day`. Today (or no date) means
 * now; an earlier date is recorded at noon of that day.
 */
function documentDate(day) {
  if (!day || day === today()) return new Date();
  return new Date(`${day}T12:00:00${DHAKA_OFFSET}`);
}

module.exports = { dayStart, dayEnd, today, documentDate };
