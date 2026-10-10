const { z } = require('zod');

const pin = z.string().regex(/^\d{6}$/, 'The PIN is 6 digits.');

// PINs a stranger would try first. Rejected when a customer chooses their own.
const WEAK_PINS = new Set(['000000', '111111', '222222', '333333', '444444', '555555', '666666', '777777', '888888', '999999', '123456', '654321', '012345', '123123', '112233']);

const portalLoginSchema = z.strictObject({
  phone: z.string().trim().min(1).max(25),
  pin: z.string().trim().min(1).max(12),
});

const changePinSchema = z.strictObject({
  currentPin: z.string().trim().min(1).max(12),
  newPin: pin.refine((value) => !WEAK_PINS.has(value), 'This PIN is too easy to guess.'),
});

module.exports = { pin, portalLoginSchema, changePinSchema };
