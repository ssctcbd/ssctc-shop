'use client';

import { useEffect, useRef, useState } from 'react';
import Modal from '@/components/Modal';
import Pager from '@/components/Pager';
import { Field, Notice, SubmitButton } from '@/components/Form';
import { api } from '@/lib/api';
import { formatDate, formatMoney } from '@/lib/format';
import { useCan } from '@/lib/session';
import { toQuery, useFetch, useForm } from '@/lib/useFetch';

const METHODS = { cash: 'Cash', bkash: 'bKash', nagad: 'Nagad', bank_transfer: 'Bank transfer', other: 'Other' };

function ExpenseForm({ categories, canBackdate, onDone, onClose }) {
  // One key per form, so a repeated save records the expense once.
  const idempotencyKey = useRef(null);
  const active = categories.filter((c) => c.isActive);
  const form = useForm({ categoryId: active[0]?.id || '', title: '', amount: '', method: 'cash', date: '', note: '' }, async (v) => {
    idempotencyKey.current ||= crypto.randomUUID();
    await api.post('/expenses', { idempotencyKey: idempotencyKey.current, categoryId: v.categoryId, title: v.title, amount: v.amount, method: v.method, ...(v.date ? { date: v.date } : {}), note: v.note });
    onDone();
  });
  const { values: v, fields: f, set } = form;

  return (
    <Modal title="Add expense" onClose={onClose}>
      <form onSubmit={form.onSubmit} noValidate>
        <Notice>{form.error}</Notice>
        <Field as="select" label="Category" required value={v.categoryId} error={f.categoryId} onChange={set('categoryId')}>
          {active.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Field>
        <Field label="What was it for?" autoFocus required maxLength={200} value={v.title} error={f.title} onChange={set('title')} placeholder="e.g. Electricity bill, October" />
        <div className="form-grid">
          <Field label="Amount (৳)" inputMode="decimal" required value={v.amount} error={f.amount} onChange={set('amount')} />
          <Field as="select" label="Paid by" value={v.method} error={f.method} onChange={set('method')} hint={v.method === 'cash' ? 'Comes out of the cash drawer.' : 'Does not touch the cash drawer.'}>
            {Object.entries(METHODS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </Field>
          {canBackdate && <Field label="Date" type="date" value={v.date} error={f.date} onChange={set('date')} hint="Leave empty for today." />}
        </div>
        <Field as="textarea" label="Note" maxLength={500} value={v.note} error={f.note} onChange={set('note')} />
        <div className="form-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <SubmitButton busy={form.busy} block={false}>
            Save expense
          </SubmitButton>
        </div>
      </form>
    </Modal>
  );
}

function CategoriesDialog({ categories, onChanged, onClose }) {
  const [error, setError] = useState('');
  const form = useForm({ name: '' }, async (v) => {
    await api.post('/expense-categories', { name: v.name });
    form.setValues({ name: '' });
    onChanged();
  });

  async function toggle(category) {
    setError('');
    try {
      await api.put(`/expense-categories/${category.id}`, { isActive: !category.isActive });
      onChanged();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <Modal title="Expense categories" onClose={onClose}>
      <Notice>{error}</Notice>
      <div className="table-wrap" style={{ marginBottom: 16 }}>
        <table className="data">
          <tbody>
            {categories.map((c) => (
              <tr key={c.id} className={c.isActive ? '' : 'inactive'}>
                <td>
                  {c.name}
                  {!c.isActive && <span className="badge badge-muted">Not used</span>}
                </td>
                <td className="num">
                  <button className="btn btn-ghost btn-sm" onClick={() => toggle(c)}>
                    {c.isActive ? 'Stop using' : 'Use again'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <form onSubmit={form.onSubmit} noValidate>
        <Field label="New category" required maxLength={100} value={form.values.name} error={form.fields.name} onChange={form.set('name')} />
        <div className="form-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Close
          </button>
          <SubmitButton busy={form.busy} block={false}>
            Add
          </SubmitButton>
        </div>
      </form>
    </Modal>
  );
}

export default function ExpensesPage() {
  const can = useCan();
  const manage = can('expenses.manage');
  const [filters, setFilters] = useState({ search: '', categoryId: '', method: '', status: 'all', from: '', to: '', page: 1 });
  const [searchText, setSearchText] = useState('');
  const [adding, setAdding] = useState(false);
  const [editingCategories, setEditingCategories] = useState(false);
  const [actionError, setActionError] = useState('');

  useEffect(() => {
    const timer = setTimeout(() => setFilters((f) => (f.search === searchText ? f : { ...f, search: searchText, page: 1 })), 300);
    return () => clearTimeout(timer);
  }, [searchText]);

  const categories = useFetch('/expense-categories');
  const categoryList = categories.data?.categories || [];
  const { data, error, loading, reload } = useFetch(`/expenses${toQuery(filters)}`);
  const items = data?.items || [];
  const setFilter = (name) => (event) => setFilters((f) => ({ ...f, [name]: event.target.value, page: 1 }));

  async function voidExpense(e) {
    const reason = window.prompt(`Why is ${e.voucherNo} (${formatMoney(e.amount)}) being voided?`);
    if (reason === null) return;
    if (reason.trim().length < 3) return setActionError('Write a reason of at least 3 characters to void an expense.');
    setActionError('');
    try {
      await api.post(`/expenses/${e.id}/void`, { reason: reason.trim() });
      reload();
    } catch (err) {
      setActionError(err.message);
    }
  }

  return (
    <>
      <div className="page-head with-actions">
        <div>
          <h1>Expenses</h1>
          <p>What the shop spends: rent, bills, paper, tea, salary.</p>
        </div>
        <div className="page-actions">
          {manage && (
            <button className="btn btn-ghost" onClick={() => setEditingCategories(true)}>
              Categories
            </button>
          )}
          {can('expenses.create') && (
            <button className="btn btn-primary" onClick={() => setAdding(true)} disabled={categoryList.length === 0}>
              Add expense
            </button>
          )}
        </div>
      </div>

      <div className="toolbar">
        <div className="field grow">
          <label htmlFor="expense-search">Search</label>
          <input id="expense-search" type="search" placeholder="What it was for, or voucher no." value={searchText} onChange={(e) => setSearchText(e.target.value)} />
        </div>
        <Field as="select" label="Category" value={filters.categoryId} onChange={setFilter('categoryId')}>
          <option value="">All</option>
          {categoryList.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Field>
        <Field as="select" label="Paid by" value={filters.method} onChange={setFilter('method')}>
          <option value="">All</option>
          {Object.entries(METHODS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </Field>
        <Field as="select" label="Show" value={filters.status} onChange={setFilter('status')}>
          <option value="all">All</option>
          <option value="active">Not voided</option>
          <option value="void">Voided only</option>
        </Field>
        <Field label="From" type="date" value={filters.from} onChange={setFilter('from')} />
        <Field label="To" type="date" value={filters.to} onChange={setFilter('to')} />
      </div>

      <Notice>{error?.message || categories.error?.message || actionError}</Notice>
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>Voucher</th>
              <th>Expense</th>
              <th>Paid by</th>
              <th className="num">Amount</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {items.map((e) => (
              <tr key={e.id} className={e.status === 'void' ? 'inactive' : ''}>
                <td className="nowrap">
                  <strong>{e.voucherNo}</strong>
                  <span className="sub">{formatDate(e.expenseDate)}</span>
                </td>
                <td>
                  {e.title}
                  {e.status === 'void' && <span className="badge badge-danger">Void</span>}
                  <span className="sub">{[e.categoryName, e.status === 'void' ? e.voidReason : e.note, `by ${e.recordedByName}`].filter(Boolean).join(' · ')}</span>
                </td>
                <td>{METHODS[e.method]}</td>
                <td className="num">{formatMoney(e.amount)}</td>
                <td className="num">
                  {manage && e.status === 'active' && (
                    <button className="btn btn-danger-ghost btn-sm" onClick={() => voidExpense(e)}>
                      Void
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
          {data && items.length > 0 && (
            <tfoot>
              <tr>
                <td colSpan={3}>Total, all {data.total} matching expenses (voided ones left out)</td>
                <td className="num">{formatMoney(data.totalAmount)}</td>
                <td />
              </tr>
            </tfoot>
          )}
        </table>
        {!loading && !error && items.length === 0 && <div className="empty">No expenses match.</div>}
      </div>
      {data && <Pager page={data.page} pageSize={data.pageSize} total={data.total} onPage={(page) => setFilters((f) => ({ ...f, page }))} />}

      {adding && (
        <ExpenseForm
          categories={categoryList}
          canBackdate={manage}
          onClose={() => setAdding(false)}
          onDone={() => {
            setAdding(false);
            reload();
          }}
        />
      )}
      {editingCategories && <CategoriesDialog categories={categoryList} onChanged={categories.reload} onClose={() => setEditingCategories(false)} />}
    </>
  );
}
