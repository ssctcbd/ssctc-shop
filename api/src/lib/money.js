// Money is DECIMAL(12,2) in MySQL and a string ("450.00") everywhere in the API.
// Arithmetic is done in whole paisa (integers), never in floating point.

const MONEY_RE = /^\d{1,10}(\.\d{1,2})?$/;

function isMoney(value) {
  return MONEY_RE.test(String(value));
}

/** "450.5" → 45050 */
function toPaisa(value) {
  const text = String(value);
  if (!MONEY_RE.test(text)) throw new TypeError(`Not a money amount: ${text}`);
  const [whole, fraction = ''] = text.split('.');
  return Number(whole) * 100 + Number((fraction + '00').slice(0, 2));
}

/** 45050 → "450.50" */
function fromPaisa(paisa) {
  if (!Number.isSafeInteger(paisa) || paisa < 0) throw new TypeError(`Not a paisa amount: ${paisa}`);
  return `${Math.trunc(paisa / 100)}.${String(paisa % 100).padStart(2, '0')}`;
}

module.exports = { isMoney, toPaisa, fromPaisa };
