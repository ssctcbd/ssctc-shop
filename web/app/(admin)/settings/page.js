'use client';

import { useEffect, useState } from 'react';
import { Checkbox, Field, Notice, SubmitButton } from '@/components/Form';
import { api } from '@/lib/api';
import { useFetch } from '@/lib/useFetch';

const TEXT_FIELDS = [
  ['shop.name', 'Shop name', 'On every screen, invoice and receipt.', 120],
  ['shop.tagline', 'Line under the shop name', '', 150],
  ['shop.address', 'Address', '', 255],
  ['shop.phone', 'Phone number', 'Printed on invoices.', 40],
  ['shop.email', 'Email', '', 120],
];
const PAYMENT_FIELDS = [
  ['payment.bkash_number', 'bKash number', 'Printed on invoices so customers know where to send money.', 20],
  ['payment.nagad_number', 'Nagad number', '', 20],
];

export default function SettingsPage() {
  const { data, error, reload } = useFetch('/settings');
  const [values, setValues] = useState(null);
  const [fields, setFields] = useState({});
  const [message, setMessage] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (data) setValues(Object.fromEntries(data.settings.filter((s) => s.editable).map((s) => [s.key, s.value])));
  }, [data]);

  const set = (key) => (event) => setValues((v) => ({ ...v, [key]: event.target.type === 'checkbox' ? event.target.checked : event.target.value }));

  async function onSubmit(event) {
    event.preventDefault();
    setMessage(null);
    setFields({});
    setBusy(true);
    try {
      const res = await api.put('/settings', { values });
      setMessage({ kind: 'success', text: res.changed.length > 0 ? `Saved. ${res.changed.length} setting(s) changed.` : 'Nothing was changed.' });
      reload();
    } catch (err) {
      // Field errors arrive as "values.shop.name".
      setFields(Object.fromEntries(Object.entries(err.fields).map(([path, text]) => [path.replace(/^values\./, ''), text])));
      setMessage({ kind: 'error', text: Object.keys(err.fields).length > 0 ? 'Please check the highlighted fields.' : err.message });
    }
    setBusy(false);
  }

  const input = ([key, label, hint, max]) => <Field key={key} label={label} maxLength={max} value={values[key] ?? ''} error={fields[key]} hint={hint || undefined} onChange={set(key)} />;

  return (
    <>
      <div className="page-head">
        <h1>Settings</h1>
        <p>The shop&apos;s details as they appear on bills, and a few switches.</p>
      </div>

      <Notice>{error?.message}</Notice>
      {values && (
        <form onSubmit={onSubmit} noValidate className="card card-narrow" style={{ maxWidth: 640 }}>
          {message && <Notice kind={message.kind}>{message.text}</Notice>}

          <h2>Shop</h2>
          {TEXT_FIELDS.map(input)}

          <h2 style={{ marginTop: 22 }}>Invoices</h2>
          <Field as="textarea" label="Line at the bottom of every invoice" maxLength={255} value={values['invoice.footer'] ?? ''} error={fields['invoice.footer']} onChange={set('invoice.footer')} />
          <Field as="select" label="Paper used unless chosen otherwise" value={values['invoice.default_layout']} error={fields['invoice.default_layout']} onChange={set('invoice.default_layout')} hint="Each computer remembers the paper last chosen on the invoice screen.">
            <option value="a4">A4 page</option>
            <option value="thermal80">Thermal 80mm</option>
            <option value="thermal58">Thermal 58mm</option>
          </Field>
          {PAYMENT_FIELDS.map(input)}

          <h2 style={{ marginTop: 22 }}>Customer portal</h2>
          <Checkbox
            label="Customers can log in to see their bills"
            hint="Switching this off logs every customer out and stops new logins. The QR code printed on a bill still opens that bill."
            checked={Boolean(values['portal.enabled'])}
            onChange={set('portal.enabled')}
          />

          <div className="form-actions">
            <SubmitButton busy={busy} block={false} busyText="Saving…">
              Save settings
            </SubmitButton>
          </div>
          <p className="field-hint">The logo and the browser-tab icon are image files that come with the website; changing them needs a new upload of the site.</p>
        </form>
      )}
    </>
  );
}
