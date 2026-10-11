'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import Modal from '@/components/Modal';
import Pager from '@/components/Pager';
import { Field, Notice } from '@/components/Form';
import { api } from '@/lib/api';
import { formatDate, formatDateTime, formatMoney } from '@/lib/format';
import { useCan } from '@/lib/session';
import { toQuery, useFetch, useForm } from '@/lib/useFetch';

const STATUS = { paid: ['Paid', 'badge-ok'], partial: ['Part paid', 'badge-warn'], unpaid: ['Unpaid', 'badge-danger'] };
const METHODS = { cash: 'Cash', bkash: 'bKash', nagad: 'Nagad', bank_transfer: 'Bank transfer', other: 'Other' };

function StatusBadge({ status }) {
  const [label, kind] = STATUS[status] || [status, 'badge-muted'];
  return <span className={`badge ${kind}`}>{label}</span>;
}

function VoidForm({ purchase, onDone, onCancel }) {
  const form = useForm({ reason: '' }, async (v) => {
    await api.post(`/purchases/${purchase.id}/void`, { reason: v.reason });
    onDone();
  });

  return (
    <form onSubmit={form.onSubmit} noValidate className="void-box">
      <Notice>{form.error !== 'Please check the highlighted fields.' && form.error}</Notice>
      <Field
        as="textarea"
        label={`Why is ${purchase.purchaseNo} being voided?`}
        autoFocus
        required
        maxLength={255}
        value={form.values.reason}
        error={form.fields.reason && 'Write the reason (at least 3 characters).'}
        onChange={form.set('reason')}
        hint="The bill stays in the list marked Void. Its products are taken back out of stock and it no longer counts toward what is owed."
      />
      <div className="form-actions">
        <button type="button" className="btn btn-ghost" onClick={onCancel}>
          Keep the bill
        </button>
        <button type="submit" className="btn btn-danger" disabled={form.busy}>
          {form.busy ? 'Voiding…' : 'Void this purchase'}
        </button>
      </div>
    </form>
  );
}

function PurchaseDetail({ id, onClose, onChanged }) {
  const can = useCan();
  const { data, error, reload } = useFetch(`/purchases/${id}`);
  const [voiding, setVoiding] = useState(false);
  const p = data?.purchase;
  const canVoid = p && can('purchases.manage') && p.status === 'active' && !p.isOpeningBalance;

  return (
    <Modal title={p ? `Purchase ${p.purchaseNo}` : 'Purchase'} onClose={onClose} wide>
      <Notice>{error?.message}</Notice>
      {p && (
        <>
          {p.status === 'void' && (
            <Notice>
              Voided on {formatDateTime(p.voidedAt)}
              {p.voidedByName ? ` by ${p.voidedByName}` : ''}. Reason: {p.voidReason}
            </Notice>
          )}
          <div className="kv">
            <div>
              <span>Supplier</span>
              {p.supplierName}
            </div>
            <div>
              <span>Date</span>
              {formatDateTime(p.purchaseDate)}
            </div>
            <div>
              <span>Supplier memo</span>
              {p.supplierMemoNo || '—'}
            </div>
            <div>
              <span>Entered by</span>
              {p.createdByName}
            </div>
          </div>

          {p.isOpeningBalance ? (
            <Notice kind="warning">Opening payable: the amount owed to this supplier before the system started. It has no product lines.</Notice>
          ) : (
            <div className="table-wrap" style={{ marginBottom: 16 }}>
              <table className="data">
                <thead>
                  <tr>
                    <th>Product</th>
                    <th className="num">Quantity</th>
                    <th className="num">Unit cost</th>
                    <th className="num">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {p.items.map((i) => (
                    <tr key={i.id}>
                      <td>
                        <strong>{i.name}</strong>
                        <span className="sub">{i.sku}</span>
                      </td>
                      <td className="num">
                        {i.quantity} {i.unit}
                      </td>
                      <td className="num">{formatMoney(i.unitCost)}</td>
                      <td className="num">{formatMoney(i.lineTotal)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="totals">
            <div>
              <span>Bill total</span>
              <span>{formatMoney(p.totalAmount)}</span>
            </div>
            <div>
              <span>Paid</span>
              <span>{formatMoney(p.paidAmount)}</span>
            </div>
            <div className="grand">
              <span>Still owed</span>
              <span>{formatMoney(p.dueAmount)}</span>
            </div>
          </div>

          {p.payments.length > 0 && (
            <p className="field-hint">
              Payments: {p.payments.map((pay) => `${pay.voucherNo} · ${formatMoney(pay.amount)} · ${METHODS[pay.method]}${pay.reference ? ` (${pay.reference})` : ''}${pay.status === 'void' ? ' — VOID' : ''}`).join('; ')}
            </p>
          )}
          {p.note && <p className="field-hint">Note: {p.note}</p>}

          {canVoid &&
            (voiding ? (
              <VoidForm
                purchase={p}
                onCancel={() => setVoiding(false)}
                onDone={() => {
                  setVoiding(false);
                  reload();
                  onChanged();
                }}
              />
            ) : (
              <div className="form-actions">
                <button type="button" className="btn btn-danger-ghost" onClick={() => setVoiding(true)}>
                  Void purchase…
                </button>
              </div>
            ))}
        </>
      )}
    </Modal>
  );
}

export default function PurchasesPage() {
  const can = useCan();
  const [filters, setFilters] = useState({ supplierId: '', status: '', from: '', to: '', page: 1 });
  const [ready, setReady] = useState(false);
  const [viewing, setViewing] = useState(null);
  const [saved, setSaved] = useState('');

  // The Suppliers screen links here with ?supplierId=…
  useEffect(() => {
    const supplierId = new URLSearchParams(window.location.search).get('supplierId');
    if (supplierId && /^\d+$/.test(supplierId)) setFilters((f) => ({ ...f, supplierId }));
    // The new-purchase form returns here with ?saved=PUR-000012
    const justSaved = new URLSearchParams(window.location.search).get('saved');
    if (justSaved && /^PUR-\d+$/.test(justSaved)) setSaved(justSaved);
    setReady(true);
  }, []);

  const { data, error, loading, reload } = useFetch(ready ? `/purchases${toQuery(filters)}` : null);
  const suppliers = useFetch('/suppliers').data?.suppliers || [];
  const items = data?.items || [];
  const setFilter = (name) => (event) => setFilters((f) => ({ ...f, [name]: event.target.value, page: 1 }));

  return (
    <>
      <div className="page-head with-actions">
        <div>
          <h1>Purchases</h1>
          <p>Bills from suppliers. Saving a bill adds its products to stock.</p>
        </div>
        {can('purchases.manage') && (
          <Link className="btn btn-primary" href="/purchases/new/">
            New purchase
          </Link>
        )}
      </div>

      <div className="toolbar">
        <Field as="select" label="Supplier" value={filters.supplierId} onChange={setFilter('supplierId')}>
          <option value="">All suppliers</option>
          {suppliers.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </Field>
        <Field as="select" label="Payment" value={filters.status} onChange={setFilter('status')}>
          <option value="">All</option>
          <option value="unpaid">Unpaid</option>
          <option value="partial">Part paid</option>
          <option value="paid">Paid</option>
        </Field>
        <Field label="From" type="date" value={filters.from} onChange={setFilter('from')} />
        <Field label="To" type="date" value={filters.to} onChange={setFilter('to')} />
      </div>

      <Notice kind="success">{saved && `Purchase ${saved} saved. Stock has been updated.`}</Notice>
      <Notice>{error?.message}</Notice>
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>No.</th>
              <th>Date</th>
              <th>Supplier</th>
              <th className="num">Total</th>
              <th className="num">Paid</th>
              <th className="num">Owed</th>
              <th>Payment</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {items.map((p) => (
              <tr key={p.id} className={p.status === 'void' ? 'inactive' : ''}>
                <td className="nowrap">
                  <strong>{p.purchaseNo}</strong>
                  {p.isOpeningBalance ? <span className="sub">Opening payable</span> : p.supplierMemoNo && <span className="sub">Memo {p.supplierMemoNo}</span>}
                </td>
                <td className="nowrap">{formatDate(p.purchaseDate)}</td>
                <td>{p.supplierName}</td>
                <td className="num">{formatMoney(p.totalAmount)}</td>
                <td className="num">{formatMoney(p.paidAmount)}</td>
                <td className="num">{formatMoney(p.dueAmount)}</td>
                <td>{p.status === 'void' ? <span className="badge badge-danger">Void</span> : <StatusBadge status={p.paymentStatus} />}</td>
                <td className="num">
                  <button className="btn btn-ghost btn-sm" onClick={() => setViewing(p.id)}>
                    View
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
          {data && items.length > 0 && (
            <tfoot>
              <tr>
                <td colSpan={3}>All {data.total} matching bills (voided bills not counted in totals)</td>
                <td className="num">{formatMoney(data.totalAmount)}</td>
                <td />
                <td className="num">{formatMoney(data.totalDue)}</td>
                <td colSpan={2} />
              </tr>
            </tfoot>
          )}
        </table>
        {ready && !loading && !error && items.length === 0 &&<div className="empty">No purchases match.</div>}
      </div>
      {data && <Pager page={data.page} pageSize={data.pageSize} total={data.total} onPage={(page) => setFilters((f) => ({ ...f, page }))} />}

      {viewing && <PurchaseDetail id={viewing} onClose={() => setViewing(null)} onChanged={reload} />}
    </>
  );
}
