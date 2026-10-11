const { query } = require('../db/pool');

/** One setting's value, or `fallback` when the row is missing. Values are stored as JSON. */
async function getSetting(key, fallback = null) {
  const rows = await query('SELECT value FROM settings WHERE setting_key = ?', [key]);
  return rows[0] ? rows[0].value : fallback;
}

/** Store a value the application keeps for itself (not one the Settings screen edits). */
async function setSetting(key, value, description = null) {
  await query('INSERT INTO settings (setting_key, value, description) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value)', [key, JSON.stringify(value), description]);
}

/** The Owner can switch the whole customer portal off in Settings. */
const portalIsOn = async () => (await getSetting('portal.enabled', true)) !== false;

module.exports = { getSetting, setSetting, portalIsOn };
