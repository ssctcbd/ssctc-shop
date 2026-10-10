const { pool } = require('../db/pool');

/**
 * Append a row to audit_logs. Pass the transaction's connection as `conn` so
 * the log entry commits or rolls back together with the change it describes.
 * This table is append-only: nothing in the application updates or deletes it.
 */
async function writeAudit({ conn = pool, actorUserId = null, action, entityType, entityId = null, oldValues = null, newValues = null, ip = null }) {
  await conn.execute(
    `INSERT INTO audit_logs (actor_user_id, action, entity_type, entity_id, old_values, new_values, ip)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      actorUserId,
      action,
      entityType,
      entityId,
      oldValues === null ? null : JSON.stringify(oldValues),
      newValues === null ? null : JSON.stringify(newValues),
      ip,
    ],
  );
}

module.exports = { writeAudit };
