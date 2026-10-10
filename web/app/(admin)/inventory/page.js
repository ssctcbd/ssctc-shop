'use client';

import { useState } from 'react';
import Modal from '@/components/Modal';
import Pager from '@/components/Pager';
import ProductPicker from '@/components/ProductPicker';
import { Field, Notice, SubmitButton } from '@/components/Form';
import { api } from '@/lib/api';
import { formatDateTime, formatMoney } from '@/lib/format';
import { useCan } from '@/lib/session';
import { toQuery, useFetch, useForm } from '@/lib/useFetch';

const TYPE_LABELS = {
  opening: 'Opening stock',
  stock_in: 'Stock in',
  purchase: 'Purchase',
  sale: 'Sale',
  sale_void: 'Sale voided',
  sale_return: 'Sale return',
  adjustment_in: 'Adjustment (+)',
  adjustment_out: 'Adjustment (−)',
};

function StockForm({ mode, products, onDone, onClose }) {
  const stockIn = mode === 'stock-in';
  const form = useForm({ productId: null, quantity: '', unitCost: '', direction: 'out', note: '' }, async (v) => {
    const base = { productId: v.productId || 0, quantity: v.quantity };
    if (stockIn) await api.post('/inventory/stock-in', { ...base, unitCost: v.unitCost === '' ? null : v.unitCost, note: v.note });
    else await api.post('/inventory/adjustments', { ...base, direction: v.direction, note: v.note });
    onDone();
  });
  const { values: v, fields: f, set } = form;

  return (
    <Modal title={stockIn ? 'Stock in' : 'Adjust stock'} onClose={onClose}>
      <form onSubmit={form.onSubmit} noValidate>
        <Notice>{form.error}</Notice>
        <ProductPicker products={products} trackedOnly autoFocus value={v.productId} error={f.productId && 'Choose a product from the list.'} onChange={(p) => form.setValues((x) => ({ ...x, productId: p ? p.id : null }))} />
        {!stockIn && (
          <Field as="select" label="Change" value={v.direction} onChange={set('direction')}>
            <option value="out">Remove from stock (damaged, lost, counted less)</option>
            <option value="in">Add to stock (found, counted more)</option>
          </Field>
        )}
        <div className="form-grid">
          <Field label="Quantity" type="number" min={1} step={1} required value={v.quantity} error={f.quantity} onChange={set('quantity')} />
          {stockIn && <Field label="Unit cost (৳)" inputMode="decimal" value={v.unitCost} error={f.unitCost} onChange={set('unitCost')} hint="Optional. Becomes the product's cost price." />}
        </div>
        <Field as="textarea" label={stockIn ? 'Note' : 'Reason'} required={!stockIn} maxLength={255} value={v.note} error={f.note} onChange={set('note')} hint={stockIn ? 'Stock bought from a supplier is better entered as a purchase.' : 'Required, so the change can be explained later.'} />
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

export default function InventoryPage() {
  const can = useCan();
  const [filters, setFilters] = useState({ productId: '', type: '', from: '', to: '', page: 1 });
  const [mode, setMode] = useState(null);

  const movements = useFetch(`/inventory/movements${toQuery(filters)}`);
  const lowStock = useFetch('/inventory/low-stock');
  const options = useFetch('/products/options');
  const reconcile = useFetch(can('inventory.adjust') ? '/inventory/reconcile' : null);

  const products = options.data?.products || [];
  const low = lowStock.data?.products || [];
  const items = movements.data?.items || [];
  const showCost = items.some((m) => 'unitCost' in m);
  const differences = reconcile.data?.differences || [];
  const setFilter = (name) => (event) => setFilters((f) => ({ ...f, [name]: event.target.value, page: 1 }));

  function afterChange() {
    setMode(null);
    movements.reload();
    lowStock.reload();
    options.reload();
    reconcile.reload();
  }

  return (
    <>
      <div className="page-head with-actions">
        <div>
          <h1>Inventory</h1>
          <p>Stock levels and the history of every change.</p>
        </div>
        {can('inventory.adjust') && (
          <div className="page-actions">
            <button className="btn btn-primary" onClick={() => setMode('stock-in')}>
              Stock in
            </button>
            <button className="btn btn-ghost" onClick={() => setMode('adjust')}>
              Adjust stock
            </button>
          </div>
        )}
      </div>

      {differences.length > 0 && (
        <Notice>
          Stock check failed for {differences.length} product(s): {differences.map((d) => `${d.name} (stock ${d.stockQty}, history ${d.ledgerTotal})`).join('; ')}. Do not adjust these — report it so the cause can be found.
        </Notice>
      )}

      <h2 className="section-title">Low stock ({low.length})</h2>
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>Code</th>
              <th>Product</th>
              <th>Category</th>
              <th className="num">In stock</th>
              <th className="num">Warn at</th>
            </tr>
          </thead>
          <tbody>
            {low.map((p) => (
              <tr key={p.id}>
                <td className="nowrap">{p.sku}</td>
                <td>
                  <strong>{p.name}</strong>
                </td>
                <td>{p.categoryName}</td>
                <td className="num">
                  <span className={`badge ${p.stockQty === 0 ? 'badge-danger' : 'badge-warn'}`}>
                    {p.stockQty} {p.unit}
                  </span>
                </td>
                <td className="num">{p.lowStockThreshold}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!lowStock.loading && low.length === 0 && <div className="empty">Nothing is running low.</div>}
      </div>

      <h2 className="section-title">Stock movement history</h2>
      <div className="toolbar">
        <Field as="select" label="Product" value={filters.productId} onChange={setFilter('productId')}>
          <option value="">All products</option>
          {products
            .filter((p) => p.trackStock)
            .map((p) => (
              <option key={p.id} value={p.id}>
                {p.sku} — {p.name}
              </option>
            ))}
        </Field>
        <Field as="select" label="Type" value={filters.type} onChange={setFilter('type')}>
          <option value="">All types</option>
          {Object.entries(TYPE_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </Field>
        <Field label="From" type="date" value={filters.from} onChange={setFilter('from')} />
        <Field label="To" type="date" value={filters.to} onChange={setFilter('to')} />
      </div>

      <Notice>{movements.error?.message}</Notice>
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>Date</th>
              <th>Product</th>
              <th>Type</th>
              <th className="num">Change</th>
              <th className="num">Balance after</th>
              {showCost && <th className="num">Unit cost</th>}
              <th>Note</th>
              <th>By</th>
            </tr>
          </thead>
          <tbody>
            {items.map((m) => (
              <tr key={m.id}>
                <td className="nowrap">{formatDateTime(m.createdAt)}</td>
                <td>
                  <strong>{m.productName}</strong>
                  <span className="sub">{m.sku}</span>
                </td>
                <td className="nowrap">{TYPE_LABELS[m.type] || m.type}</td>
                <td className={`num ${m.quantity > 0 ? 'qty-in' : 'qty-out'}`}>{m.quantity > 0 ? `+${m.quantity}` : m.quantity}</td>
                <td className="num">{m.balanceAfter}</td>
                {showCost && <td className="num">{m.unitCost ? formatMoney(m.unitCost) : ''}</td>}
                <td>{m.note}</td>
                <td className="nowrap">{m.userName}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!movements.loading && items.length === 0 && <div className="empty">No stock movements match.</div>}
      </div>
      {movements.data && <Pager page={movements.data.page} pageSize={movements.data.pageSize} total={movements.data.total} onPage={(page) => setFilters((f) => ({ ...f, page }))} />}

      {mode && <StockForm mode={mode} products={products} onClose={() => setMode(null)} onDone={afterChange} />}
    </>
  );
}
