const { z } = require('zod');
const { isMoney, toPaisa, fromPaisa } = require('./money');

// Building blocks shared by the module schemas.

/** A positive row id, accepted as a number or a numeric string. */
const id = z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER);

/** A money amount ≥ 0 with at most two decimals. Output is normalised: "450.50". */
const money = z
  .union([z.string().trim(), z.number()])
  .transform((v) => String(v))
  .refine(isMoney, 'Enter an amount like 450 or 450.50.')
  .transform((v) => fromPaisa(toPaisa(v)));

const positiveMoney = money.refine((v) => toPaisa(v) > 0, 'Enter an amount greater than zero.');

/** Stock quantities are whole units. */
const quantity = z.coerce.number().int('Enter a whole number.').min(1, 'Enter at least 1.').max(1_000_000);

/** Optional free text: empty or blank becomes null. */
const optionalText = (max) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((v) => v || null);

/** As optionalText, for partial updates: a field left out stays undefined (unchanged). */
const optionalTextUpdate = (max) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .optional()
    .transform((v) => (v === undefined ? undefined : v || null));

const requiredText =(min, max) => z.string().trim().min(min, 'This field is required.').max(max);

const flag = z.boolean();

/** A calendar date as picked in the shop (Asia/Dhaka), "YYYY-MM-DD". */
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the format YYYY-MM-DD.').refine((v) => !Number.isNaN(Date.parse(`${v}T00:00:00+06:00`)), 'Not a real date.');

/** Query-string flag: "1"/"true" → true, "0"/"false" → false. */
const queryFlag = z.enum(['1', '0', 'true', 'false']).transform((v) => v === '1' || v === 'true');

/** A commission rate: a percentage of what the line sold for, or a fixed amount per unit. null = none. */
const commissionType = z.enum(['percent', 'fixed']).nullable();
const commissionValue = money.refine((v) => toPaisa(v) < 10_000_000_000, 'Too large.');

/** The checks a rate needs once type and value are both known. Returns { field: message } or null. */
function commissionProblem(type, value) {
  if (type === 'percent' && toPaisa(value) > 10000) return { commissionValue: 'A percentage cannot be more than 100.' };
  if (type && toPaisa(value) === 0) return { commissionValue: 'Enter the rate, or choose no commission.' };
  return null;
}

const paging = {
  page: z.coerce.number().int().min(1).max(100000).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
};

module.exports = { z, id, money, positiveMoney, quantity, optionalText, optionalTextUpdate, requiredText, flag, day, queryFlag, paging, commissionType, commissionValue, commissionProblem };
