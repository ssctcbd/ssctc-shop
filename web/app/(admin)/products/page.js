'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import Modal from '@/components/Modal';
import Pager from '@/components/Pager';
import { Checkbox, Field, Notice, SubmitButton } from '@/components/Form';
import { api } from '@/lib/api';
import { formatMoney } from '@/lib/format';
import { useCan } from '@/lib/session';
import { toQuery, useFetch, useForm } from '@/lib/useFetch';

function CategoryOptions({ categories }) {
  const parents = categories.filter((c) => c.parentId === null);
  return parents.flatMap((p) => [
    <option key={p.id} value={p.id}>
      {p.name}
    </option>,
    ...categories
      .filter((c) => c.parentId === p.id)
      .map((c) => (
        <option key={c.id} value={c.id}>
          {'   '}
          {c.name}
        </option>
      )),
  ]);
}

function ProductForm({ product, categories, canEditPrice, onDone, onClose }) {
  const editing = Boolean(product);
  const form = useForm(
    {
      categoryId: product?.categoryId || '',
      sku: product?.sku || '',
      name: product?.name || '',
      brand: product?.brand || '',
      unit: product?.unit || 'pcs',
      price: product?.price || '',
      costPrice: product?.costPrice || '',
      trackStock: product?.trackStock ?? true,
      lowStockThreshold: product?.lowStockThreshold ?? 5,
      note: product?.note || '',
      openingStock: 0,
      status: product?.status || 'active',
    },
    async (v) => {
      const body = {
        categoryId: Number(v.categoryId) || 0,
        name: v.name,
        brand: v.brand,
        unit: v.unit,
        trackStock: v.trackStock,
        lowStockThreshold: Number(v.lowStockThreshold) || 0,
        note: v.note,
      };
      // Prices are sent only by users allowed to change them.
      if (canEditPrice || !editing) Object.assign(body, { price: v.price, costPrice: v.costPrice || '0' });
      if (editing) await api.put(`/products/${product.id}`, { ...body, sku: v.sku, status: v.status });
      else await api.post('/products', { ...body, sku: v.sku || null, openingStock: Number(v.openingStock) || 0 });
      onDone();
    },
  );
  const { values: v, fields: f, set } = form;
  const active = categories.filter((c) => c.isActive || c.id === product?.categoryId);

  return (
    <Modal title={editing ? 'Edit product' : 'Add product'} onClose={onClose} wide>
      <form onSubmit={form.onSubmit} noValidate>
        <Notice>{form.error}</Notice>
        <div className="form-grid">
          <div className="span-2">
            <Field label="Product name" autoFocus required maxLength={200} value={v.name} error={f.name} onChange={set('name')} />
          </div>
          <Field as="select" label="Category" required value={v.categoryId} error={f.categoryId} onChange={set('categoryId')}>
            <option value="">Choose…</option>
            <CategoryOptions categories={active} />
          </Field>
          <Field label="Code (SKU / barcode)" maxLength={50} value={v.sku} error={f.sku} onChange={set('sku')} hint={editing ? undefined : 'Leave empty to generate one.'} />
          <Field label="Brand" maxLength={100} value={v.brand} error={f.brand} onChange={set('brand')} />
          <Field label="Unit" required maxLength={20} placeholder="pcs, rim, box" value={v.unit} error={f.unit} onChange={set('unit')} />
          <Field label="Selling price (৳)" inputMode="decimal" required disabled={editing && !canEditPrice} value={v.price} error={f.price} onChange={set('price')} />
          <Field label="Cost price (৳)" inputMode="decimal" disabled={editing && !canEditPrice} value={v.costPrice} error={f.costPrice} onChange={set('costPrice')} hint="What the shop pays. Updated automatically by purchases." />
          <Field label="Low-stock warning at" type="number" min={0} value={v.lowStockThreshold} error={f.lowStockThreshold} onChange={set('lowStockThreshold')} />
          {editing ? (
            <Field as="select" label="Status" value={v.status} error={f.status} onChange={set('status')} hint="Archived products are hidden and cannot be sold.">
              <option value="active">Active</option>
              <option value="archived">Archived</option>
            </Field>
          ) : (
            <Field label="Opening stock" type="number" min={0} disabled={!v.trackStock} value={v.openingStock} error={f.openingStock} onChange={set('openingStock')} hint="How many are on the shelf now." />
          )}
          <div className="span-2">
            <Checkbox label="Track stock for this product" hint={f.trackStock || 'Turn off for items you do not count.'} checked={v.trackStock} onChange={set('trackStock')} />
            <Field as="textarea" label="Note" maxLength={255} value={v.note} error={f.note} onChange={set('note')} />
          </div>
        </div>
        {editing && (
          <p className="field-hint">
            Stock ({product.stockQty} {product.unit}) is changed from <Link href="/inventory/">Inventory</Link> or a purchase, never here.
          </p>
        )}
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

function StockCell({ product }) {
  if (!product.trackStock) return <span className="muted">Not tracked</span>;
  const kind = product.stockQty === 0 ? 'badge-danger' : product.isLowStock ? 'badge-warn' : 'badge-ok';
  return (
    <span className={`badge ${kind}`}>
      {product.stockQty} {product.unit}
    </span>
  );
}

export default function ProductsPage() {
  const can = useCan();
  const [filters, setFilters] = useState({ search: '', categoryId: '', status: 'active', lowStock: false, page: 1 });
  const [searchText, setSearchText] = useState('');
  const [editing, setEditing] = useState(undefined);

  // Search as the user types, after a short pause.
  useEffect(() => {
    const timer = setTimeout(() => setFilters((f) => (f.search === searchText ? f : { ...f, search: searchText, page: 1 })), 300);
    return () => clearTimeout(timer);
  }, [searchText]);

  const { data, error, loading, reload } = useFetch(`/products${toQuery(filters)}`);
  const categories = useFetch('/categories').data?.categories || [];
  const items = data?.items || [];
  const showCost = items.some((p) => 'costPrice' in p);
  const setFilter = (name) => (event) => setFilters((f) => ({ ...f, [name]: event.target.type === 'checkbox' ? event.target.checked : event.target.value, page: 1 }));

  return (
    <>
      <div className="page-head with-actions">
        <div>
          <h1>Products</h1>
          <p>Stationery, gadgets and other items the shop sells.</p>
        </div>
        {can('catalog.manage') && (
          <button className="btn btn-primary" onClick={() => setEditing(null)} disabled={categories.length === 0} title={categories.length === 0 ? 'Add a category first' : undefined}>
            Add product
          </button>
        )}
      </div>

      <div className="toolbar">
        <div className="field grow">
          <label htmlFor="product-search">Search</label>
          <input id="product-search" type="search" placeholder="Name, code or brand" value={searchText} onChange={(e) => setSearchText(e.target.value)} />
        </div>
        <Field as="select" label="Category" value={filters.categoryId} onChange={setFilter('categoryId')}>
          <option value="">All categories</option>
          <CategoryOptions categories={categories} />
        </Field>
        <Field as="select" label="Status" value={filters.status} onChange={setFilter('status')}>
          <option value="active">Active</option>
          <option value="archived">Archived</option>
          <option value="all">All</option>
        </Field>
        <Checkbox label="Low stock only" checked={filters.lowStock} onChange={setFilter('lowStock')} />
      </div>

      <Notice>{error?.message}</Notice>
      {!loading && categories.length === 0 && (
        <Notice kind="warning">
          Products need a category. <Link href="/categories/">Add a category first</Link>.
        </Notice>
      )}

      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>Code</th>
              <th>Product</th>
              <th>Category</th>
              <th className="num">Price</th>
              {showCost && <th className="num">Cost</th>}
              <th>Stock</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {items.map((p) => (
              <tr key={p.id} className={p.status === 'archived' ? 'inactive' : ''}>
                <td className="nowrap">{p.sku}</td>
                <td>
                  <strong>{p.name}</strong>
                  {p.brand && <span className="sub">{p.brand}</span>}
                  {p.status === 'archived' && <span className="badge badge-muted">Archived</span>}
                </td>
                <td>{p.categoryName}</td>
                <td className="num">{formatMoney(p.price)}</td>
                {showCost && <td className="num">{formatMoney(p.costPrice)}</td>}
                <td>
                  <StockCell product={p} />
                </td>
                <td className="num">
                  {can('catalog.manage') && (
                    <button className="btn btn-ghost btn-sm" onClick={() => setEditing(p)}>
                      Edit
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!loading && items.length === 0 && <div className="empty">No products match.</div>}
      </div>
      {data && <Pager page={data.page} pageSize={data.pageSize} total={data.total} onPage={(page) => setFilters((f) => ({ ...f, page }))} />}

      {editing !== undefined && (
        <ProductForm
          product={editing}
          categories={categories}
          canEditPrice={can('catalog.edit_price')}
          onClose={() => setEditing(undefined)}
          onDone={() => {
            setEditing(undefined);
            reload();
          }}
        />
      )}
    </>
  );
}
