const PREFIXES = {
  invoice: 'INV',
  receipt: 'RCP',
  purchase: 'PUR',
  supplier_payment: 'SPAY',
  expense: 'EXP',
  return: 'RET',
};

/**
 * Take the next number for a document type, e.g. "PUR-000045".
 *
 * Must be called with the connection of the transaction that creates the
 * document: the counter row is locked until that transaction ends, so numbers
 * are sequential, never duplicated, and a failed save does not consume one
 * (DATABASE_SCHEMA.md §4.10).
 */
async function nextDocumentNumber(conn, docType) {
  const prefix = PREFIXES[docType];
  if (!prefix) throw new Error(`Unknown document type: ${docType}`);
  const [rows] = await conn.execute('SELECT last_number FROM document_counters WHERE doc_type = ? FOR UPDATE', [docType]);
  if (!rows[0]) throw new Error(`document_counters has no row for "${docType}"; run the seed.`);
  const next = rows[0].last_number + 1;
  await conn.execute('UPDATE document_counters SET last_number = ? WHERE doc_type = ?', [next, docType]);
  return `${prefix}-${String(next).padStart(6, '0')}`;
}

module.exports = { nextDocumentNumber };
