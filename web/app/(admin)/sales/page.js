'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import Modal from '@/components/Modal';
import Pager from '@/components/Pager';
import { Checkbox, Field, Notice } from '@/components/Form';
import { api } from '@/lib/api';
import { formatDateTime, formatMoney } from '@/lib/format';
import { useCan } from '@/lib/session';
import { toQuery, useFetch, useForm } from '@/lib/useFetch';

const METHODS = { cash: 'Cash', bkash: 'bKash', nagad: 'Nagad', bank_transfer: 'Bank transfer', other: 'Other' };
const PAY_STATUS = { paid: ['Paid', 'badge-ok'], partial: ['Part paid', 'badge-warn'], unpaid: ['Unpaid', 'badge-danger'] };

function SaleBadge({ sale }) {
  if (sale.status === 'void') return <span className="badge badge-danger">Void</span>;
  const [label, kind] = PAY_STATUS[sale.paymentStatus];
  return <span className={`badge ${kind}`}>{label}</span>;
}

function VoidSaleForm({ sale, onDone, onCancel }) {
  const activePayments = sale.payments.filter((p) => p.status === 'active');
  const refund = activePayments.reduce((sum, p) => sum + Number(p.amount), 0);
  const form = useForm({ reason: '', voidPayments: false }, async (v) => {
    await api.post(`/sales/${sale.id}/void`, { reason: v.reason, voidPayments: activePayments.length > 0 && v.voidPayments });
    onDone();
  });
  const blocked = activePayments.length > 0 && !form.values.voidPayments;

  return (
    <form onSubmit={form.onSubmit} noValidate className="void-box">
      <Notice>{form.error !== 'Please check the highlighted fields.' && form.error}</Notice>
      <Field
        as="textarea"
        label={`Why is ${sale.invoiceNo} being voided?`}
        autoFocus
        required
        maxLength={255}
        value={form.values.reason}
        error={form.fields.reason && 'Write the reason (at least 3 characters).'}
        onChange={form.set('reason')}
        hint="The sale stays in the list marked Void, and its products go back into stock."
      />
      {activePayments.length > 0 && (
        <Checkbox label={`Also void its ${activePayments.length} payment(s): ${formatMoney(refund)} goes back to the customer`} checked={form.values.voidPayments} onChange={form.set('voidPayments')} />
      )}
      <div className="form-actions">
        <button type="button" className="btn btn-ghost" onClick={onCancel}>
          Keep the sale
        </button>
        <button type="submit" className="btn btn-danger" disabled={form.busy || blocked}>
          {form.busy ? 'Voiding…' : 'Void this sale'}
        </button>
      </div>
    </form>
  );
}

function SaleDetail({ id, onClose, onChanged }) {
  const can = useCan();
  const { data, error, reload } = useFetch(`/sales/${id}`);
  const [voiding, setVoiding] = useState(false);
  const [actionError, setActionError] = useState('');
  const s = data?.sale;

  async function act(path, body) {
    setActionError('');
    try {
      await api.post(path, body);
      reload();
      onChanged();
    } catch (err) {
      setActionError(err.message);
    }
  }
  function voidPayment(p) {
    const reason = window.prompt(`Why is receipt ${p.receiptNo} (${formatMoney(p.amount)}) being voided?`);
    if (reason && reason.trim().length >= 3) act(`/payments/${p.id}/void`, { reason: reason.trim() });
    else if (reason !== null) setActionError('Write a reason of at least 3 characters to void a payment.');
  }

  return (
    <Modal title={s ? `Sale ${s.invoiceNo}` : 'Sale'} onClose={onClose} wide>
      <Notice>{error?.message || actionError}</Notice>
      {s && (
        <>
          {s.status === 'void' && (
            <Notice>
              Voided on {formatDateTime(s.voidedAt)}
              {s.voidedByName ? ` by ${s.voidedByName}` : ''}. Reason: {s.voidReason}
            </Notice>
          )}
          <div className="kv">
            <div>
              <span>Customer</span>
              {s.customerName || 'Walk-in'}
              {s.customerPhone ? ` · ${s.customerPhone}` : ''}
            </div>
            <div>
              <span>Date</span>
              {formatDateTime(s.saleDate)}
            </div>
            <div>
              <span>Sold by</span>
              {s.createdByName}
            </div>
            <div>
              <span>Status</span>
              <SaleBadge sale={s} />
            </div>
          </div>

          <div className="table-wrap" style={{ marginBottom: 16 }}>
            <table className="data">
              <thead>
                <tr>
                  <th>Item</th>
                  <th className="num">Qty</th>
                  <th className="num">Price</th>
                  <th className="num">Total</th>
                </tr>
              </thead>
              <tbody>
                {s.items.map((i) => (
                  <tr key={i.id}>
                    <td>
                      <strong>{i.name}</strong>
                      {(i.sku || i.warranty || i.serialNo) && <span className="sub">{[i.sku, i.warranty && `Warranty ${i.warranty}`, i.serialNo && `S/N ${i.serialNo}`].filter(Boolean).join(' · ')}</span>}
                    </td>
                    <td className="num">
                      {i.quantity} {i.unit}
                    </td>
                    <td className="num">{formatMoney(i.unitPrice)}</td>
                    <td className="num">{formatMoney(i.lineTotal)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="totals">
            <div>
              <span>Subtotal</span>
              <span>{formatMoney(s.subtotal)}</span>
            </div>
            {Number(s.discountAmount) > 0 && (
              <div>
                <span>Discount</span>
                <span>− {formatMoney(s.discountAmount)}</span>
              </div>
            )}
            <div>
              <span>Total</span>
              <span>{formatMoney(s.totalAmount)}</span>
            </div>
            <div>
              <span>Paid (verified)</span>
              <span>{formatMoney(s.paidAmount)}</span>
            </div>
            {Number(s.unverifiedAmount) > 0 && (
              <div>
                <span>Awaiting verification</span>
                <span>{formatMoney(s.unverifiedAmount)}</span>
              </div>
            )}
            <div className="grand">
              <span>Due</span>
              <span>{s.status === 'void' ? '—' : formatMoney(s.dueAmount)}</span>
            </div>
          </div>

          <h2 className="section-title">Payments</h2>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Receipt</th>
                  <th>Method</th>
                  <th className="num">Amount</th>
                  <th>Standing</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {s.payments.map((p) => (
                  <tr key={p.id} className={p.status === 'void' ? 'inactive' : ''}>
                    <td className="nowrap">
                      <strong>{p.receiptNo}</strong>
                      <span className="sub">{formatDateTime(p.paymentDate)}</span>
                    </td>
                    <td>
                      {METHODS[p.method]}
                      {p.reference && <span className="sub">{p.reference}</span>}
                    </td>
                    <td className="num">{formatMoney(p.amount)}</td>
                    <td>
                      {p.status === 'void' ? <span className="badge badge-danger">Void</span> : p.isVerified ? <span className="badge badge-ok">Verified</span> : <span className="badge badge-warn">Unverified</span>}
                      {p.voidReason && <span className="sub">{p.voidReason}</span>}
                    </td>
                    <td className="num nowrap">
                      {p.status === 'active' && s.status === 'completed' && (
                        <>
                          {can('payments.verify') &&
                            (p.isVerified ? (
                              p.method !== 'cash' && (
                                <button className="btn btn-ghost btn-sm" onClick={() => act(`/payments/${p.id}/unverify`)}>
                                  Unverify
                                </button>
                              )
                            ) : (
                              <button className="btn btn-primary btn-sm" onClick={() => act(`/payments/${p.id}/verify`)}>
                                Verify
                              </button>
                            ))}{' '}
                          {can('payments.void') && (
                            <button className="btn btn-danger-ghost btn-sm" onClick={() => voidPayment(p)}>
                              Void
                            </button>
                          )}
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {s.payments.length === 0 && <div className="empty">No payment recorded.</div>}
          </div>
          {s.note && <p className="field-hint">Note: {s.note}</p>}

          {voiding ? (
            <VoidSaleForm
              sale={s}
              onCancel={() => setVoiding(false)}
              onDone={() => {
                setVoiding(false);
                reload();
                onChanged();
              }}
            />
          ) : (
            <div className="form-actions">
              {can('sales.void') && s.status === 'completed' && s.saleType === 'sale' && (
                <button type="button" className="btn btn-danger-ghost" onClick={() => setVoiding(true)}>
                  Void sale…
                </button>
              )}
              {s.saleType === 'sale' && (
                <Link className="btn btn-primary" href={`/sales/invoice/?id=${s.id}`}>
                  Invoice
                </Link>
              )}
            </div>
          )}
        </>
      )}
    </Modal>
  );
}

export default function SalesPage() {
  const can = useCan();
  const [filters, setFilters] = useState({ search: '', status: 'all', paymentStatus: '', method: '', from: '', to: '', page: 1 });
  const [searchText, setSearchText] = useState('');
  const [viewing, setViewing] = useState(null);

  useEffect(() => {
    const timer = setTimeout(() => setFilters((f) => (f.search === searchText ? f : { ...f, search: searchText, page: 1 })), 300);
    return () => clearTimeout(timer);
  }, [searchText]);

  const { data, error, loading, reload } = useFetch(`/sales${toQuery(filters)}`);
  const items = data?.items || [];
  const setFilter = (name) => (event) => setFilters((f) => ({ ...f, [name]: event.target.value, page: 1 }));

  return (
    <>
      <div className="page-head with-actions">
        <div>
          <h1>Sales</h1>
          <p>Every bill, with what was paid and what is still due.</p>
        </div>
        {can('sales.create') && (
          <Link className="btn btn-primary" href="/pos/">
            New sale
          </Link>
        )}
      </div>

      <div className="toolbar">
        <div className="field grow">
          <label htmlFor="sale-search">Search</label>
          <input id="sale-search" type="search" placeholder="Invoice no., customer or mobile" value={searchText} onChange={(e) => setSearchText(e.target.value)} />
        </div>
        <Field as="select" label="Payment" value={filters.paymentStatus} onChange={setFilter('paymentStatus')}>
          <option value="">All</option>
          <option value="unpaid">Unpaid</option>
          <option value="partial">Part paid</option>
          <option value="paid">Paid</option>
        </Field>
        <Field as="select" label="Method" value={filters.method} onChange={setFilter('method')}>
          <option value="">All</option>
          {Object.entries(METHODS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </Field>
        <Field as="select" label="Show" value={filters.status} onChange={setFilter('status')}>
          <option value="all">All sales</option>
          <option value="completed">Not voided</option>
          <option value="void">Voided only</option>
        </Field>
        <Field label="From" type="date" value={filters.from} onChange={setFilter('from')} />
        <Field label="To" type="date" value={filters.to} onChange={setFilter('to')} />
      </div>

      <Notice>{error?.message}</Notice>
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>Invoice</th>
              <th>Date</th>
              <th>Customer</th>
              <th className="num">Total</th>
              <th className="num">Paid</th>
              <th className="num">Due</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {items.map((s) => (
              <tr key={s.id} className={s.status === 'void' ? 'inactive' : ''}>
                <td className="nowrap">
                  <strong>{s.invoiceNo}</strong>
                  {s.saleType === 'opening_due' && <span className="sub">Opening due</span>}
                </td>
                <td className="nowrap">{formatDateTime(s.saleDate)}</td>
                <td>
                  {s.customerName || 'Walk-in'}
                  {s.customerPhone && <span className="sub">{s.customerPhone}</span>}
                </td>
                <td className="num">{formatMoney(s.totalAmount)}</td>
                <td className="num">
                  {formatMoney(s.paidAmount)}
                  {s.status === 'completed' && Number(s.unverifiedAmount) > 0 && <span className="sub">+ {formatMoney(s.unverifiedAmount)} unverified</span>}
                </td>
                <td className="num">{s.status === 'void' ? '—' : Number(s.dueAmount) > 0 ? <span className="qty-out">{formatMoney(s.dueAmount)}</span> : formatMoney(0)}</td>
                <td>
                  <SaleBadge sale={s} />
                </td>
                <td className="num">
                  <button className="btn btn-ghost btn-sm" onClick={() => setViewing(s.id)}>
                    View
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
          {data && items.length > 0 && (
            <tfoot>
              <tr>
                <td colSpan={3}>All {data.total} matching sales (voided not counted)</td>
                <td className="num">{formatMoney(data.totalAmount)}</td>
                <td className="num">{formatMoney(data.totalPaid)}</td>
                <td className="num">{formatMoney(data.totalDue)}</td>
                <td colSpan={2} />
              </tr>
            </tfoot>
          )}
        </table>
        {!loading && !error && items.length === 0 && <div className="empty">No sales match.</div>}
      </div>
      {data && <Pager page={data.page} pageSize={data.pageSize} total={data.total} onPage={(page) => setFilters((f) => ({ ...f, page }))} />}

      {viewing && <SaleDetail id={viewing} onClose={() => setViewing(null)} onChanged={reload} />}
    </>
  );
}
