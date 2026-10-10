'use client';

import { useState } from 'react';
import Link from 'next/link';
import Modal from '@/components/Modal';
import { Checkbox, Field, Notice, SubmitButton } from '@/components/Form';
import { api } from '@/lib/api';
import { formatMoney, sumMoney } from '@/lib/format';
import { useCan } from '@/lib/session';
import { useFetch, useForm } from '@/lib/useFetch';

function SupplierForm({ supplier, onDone, onClose }) {
  const editing = Boolean(supplier);
  const form = useForm(
    { name: supplier?.name || '', company: supplier?.company || '', phone: supplier?.phone || '', address: supplier?.address || '', note: supplier?.note || '', isActive: supplier?.isActive ?? true },
    async (v) => {
      const body = { name: v.name, company: v.company, phone: v.phone, address: v.address, note: v.note };
      if (editing) await api.put(`/suppliers/${supplier.id}`, { ...body, isActive: v.isActive });
      else await api.post('/suppliers', body);
      onDone();
    },
  );
  const { values: v, fields: f, set } = form;

  return (
    <Modal title={editing ? 'Edit supplier' : 'Add supplier'} onClose={onClose}>
      <form onSubmit={form.onSubmit} noValidate>
        <Notice>{form.error}</Notice>
        <Field label="Name" autoFocus required maxLength={120} value={v.name} error={f.name} onChange={set('name')} />
        <div className="form-grid">
          <Field label="Company" maxLength={150} value={v.company} error={f.company} onChange={set('company')} />
          <Field label="Mobile" type="tel" maxLength={15} value={v.phone} error={f.phone} onChange={set('phone')} />
        </div>
        <Field label="Address" maxLength={255} value={v.address} error={f.address} onChange={set('address')} />
        <Field as="textarea" label="Note" maxLength={255} value={v.note} error={f.note} onChange={set('note')} />
        {editing && <Checkbox label="Active" hint="Inactive suppliers cannot be chosen for new purchases." checked={v.isActive} onChange={set('isActive')} />}
        <div className="form-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <SubmitButton busy={form.busy} block={false}>
            Save
          </SubmitButton>
        </div>
      </form>
    </Modal>
  );
}

function OpeningPayableForm({ supplier, onDone, onClose }) {
  const form = useForm({ amount: '', date: '', note: '' }, async (v) => {
    await api.post(`/suppliers/${supplier.id}/opening-payable`, { amount: v.amount, ...(v.date ? { date: v.date } : {}), note: v.note });
    onDone();
  });
  const { values: v, fields: f, set } = form;

  return (
    <Modal title={`Opening payable — ${supplier.name}`} onClose={onClose}>
      <form onSubmit={form.onSubmit} noValidate>
        <p className="muted" style={{ marginBottom: 14 }}>
          What the shop already owed this supplier before using this system. It can be recorded once.
        </p>
        <Notice>{form.error}</Notice>
        <div className="form-grid">
          <Field label="Amount owed (৳)" inputMode="decimal" autoFocus required value={v.amount} error={f.amount} onChange={set('amount')} />
          <Field label="As of date" type="date" value={v.date} error={f.date} onChange={set('date')} hint="Leave empty for today." />
        </div>
        <Field as="textarea" label="Note" maxLength={500} value={v.note} error={f.note} onChange={set('note')} />
        <div className="form-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <SubmitButton busy={form.busy} block={false}>
            Save
          </SubmitButton>
        </div>
      </form>
    </Modal>
  );
}

export default function SuppliersPage() {
  const can = useCan();
  const { data, error, loading, reload } = useFetch('/suppliers');
  const [editing, setEditing] = useState(undefined);
  const [opening, setOpening] = useState(null);
  const suppliers = data?.suppliers || [];
  const manage = can('suppliers.manage');
  const done = () => {
    setEditing(undefined);
    setOpening(null);
    reload();
  };

  return (
    <>
      <div className="page-head with-actions">
        <div>
          <h1>Suppliers</h1>
          <p>Who the shop buys from, and how much is owed to each.</p>
        </div>
        {manage && (
          <button className="btn btn-primary" onClick={() => setEditing(null)}>
            Add supplier
          </button>
        )}
      </div>

      <Notice>{error?.message}</Notice>
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>Supplier</th>
              <th>Mobile</th>
              <th className="num">Payable</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {suppliers.map((s) => (
              <tr key={s.id} className={s.isActive ? '' : 'inactive'}>
                <td>
                  <strong>{s.name}</strong>
                  {s.company && <span className="sub">{s.company}</span>}
                  {!s.isActive && <span className="badge badge-muted">Inactive</span>}
                </td>
                <td className="nowrap">{s.phone}</td>
                <td className="num">{Number(s.currentPayable) > 0 ? <span className="qty-out">{formatMoney(s.currentPayable)}</span> : formatMoney(0)}</td>
                <td className="num nowrap">
                  <Link className="btn btn-ghost btn-sm" href={`/purchases/?supplierId=${s.id}`}>
                    Purchases
                  </Link>{' '}
                  {manage && (
                    <>
                      <button className="btn btn-ghost btn-sm" onClick={() => setOpening(s)}>
                        Opening payable
                      </button>{' '}
                      <button className="btn btn-ghost btn-sm" onClick={() => setEditing(s)}>
                        Edit
                      </button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
          {suppliers.length > 0 && (
            <tfoot>
              <tr>
                <td colSpan={2}>Total payable</td>
                <td className="num">{formatMoney(sumMoney(suppliers.map((s) => s.currentPayable)))}</td>
                <td />
              </tr>
            </tfoot>
          )}
        </table>
        {!loading && !error && suppliers.length === 0 &&<div className="empty">No suppliers yet.</div>}
      </div>

      {editing !== undefined && <SupplierForm supplier={editing} onClose={() => setEditing(undefined)} onDone={done} />}
      {opening && <OpeningPayableForm supplier={opening} onClose={() => setOpening(null)} onDone={done} />}
    </>
  );
}
