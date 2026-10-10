const BN_DIGITS = '০১২৩৪৫৬৭৮৯';

/**
 * Normalise a Bangladeshi mobile number to 01XXXXXXXXX.
 * Accepts +8801…, 8801…, 01…, spaces, dashes and Bangla digits.
 * Returns null when the input is not a valid mobile number.
 */
function normalizePhone(input) {
  if (typeof input !== 'string') return null;
  let digits = '';
  for (const ch of input) {
    const bn = BN_DIGITS.indexOf(ch);
    if (bn !== -1) digits += bn;
    else if (ch >= '0' && ch <= '9') digits += ch;
  }
  if (digits.startsWith('880')) digits = digits.slice(2);
  else if (digits.length === 10 && digits.startsWith('1')) digits = `0${digits}`;
  return /^01[3-9]\d{8}$/.test(digits) ? digits : null;
}

module.exports = { normalizePhone };
