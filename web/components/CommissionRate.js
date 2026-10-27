'use client';

import { Field } from './Form';
import { formatMoney } from '@/lib/format';

/** "10%", "৳ 0.50 per page" or "None". */
export function describeRate(type, value, unit = 'unit') {
  if (type === 'percent') return `${Number(value)}%`;
  if (type === 'fixed') return `${formatMoney(value)} per ${unit}`;
  return 'None';
}

/** The body fields for a rate, as the API takes them. */
export const rateBody = (v) => ({ commissionType: v.commissionType || null, commissionValue: v.commissionType ? v.commissionValue || '0' : '0' });

/**
 * Staff commission on a service or a product category: none, a percentage of
 * what the line sold for, or a fixed amount per unit. Works with useForm: the
 * form's values hold commissionType ('' = none) and commissionValue.
 */
export default function CommissionRate({ form, unit = 'unit', inheritHint }) {
  const { values: v, fields: f, set } = form;
  return (
    <div className="form-grid">
      <Field as="select" label="Staff commission" value={v.commissionType} error={f.commissionType} onChange={set('commissionType')} hint={!v.commissionType && inheritHint ? inheritHint : undefined}>
        <option value="">None</option>
        <option value="percent">Percentage of the sale</option>
        <option value="fixed">Fixed amount per {unit}</option>
      </Field>
      {v.commissionType && (
        <Field
          label={v.commissionType === 'percent' ? 'Commission (%)' : `Commission (৳ per ${unit})`}
          inputMode="decimal"
          required
          value={v.commissionValue}
          error={f.commissionValue}
          onChange={set('commissionValue')}
          hint={v.commissionType === 'percent' ? 'Of what the line sold for, after any discount.' : 'Earned on every unit sold.'}
        />
      )}
    </div>
  );
}
