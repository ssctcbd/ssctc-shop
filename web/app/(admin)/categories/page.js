'use client';

import { useState } from 'react';
import Modal from '@/components/Modal';
import { Checkbox, Field, Notice, SubmitButton } from '@/components/Form';
import { api } from '@/lib/api';
import { useCan } from '@/lib/session';
import { useFetch, useForm } from '@/lib/useFetch';

function CategoryForm({ category, parents, onDone, onClose }) {
  const editing = Boolean(category);
  const form = useForm(
    { name: category?.name || '', parentId: category?.parentId || '', sortOrder: category?.sortOrder ?? 0, isActive: category?.isActive ?? true },
    async (v) => {
      const body = { name: v.name, parentId: v.parentId ? Number(v.parentId) : null, sortOrder: Number(v.sortOrder) || 0 };
      if (editing) await api.put(`/categories/${category.id}`, { ...body, isActive: v.isActive });
      else await api.post('/categories', body);
      onDone();
    },
  );

  return (
    <Modal title={editing ? 'Edit category' : 'Add category'} onClose={onClose}>
      <form onSubmit={form.onSubmit} noValidate>
        <Notice>{form.error}</Notice>
        <Field label="Name" autoFocus required maxLength={100} value={form.values.name} error={form.fields.name} onChange={form.set('name')} />
        <Field as="select" label="Parent category" value={form.values.parentId} error={form.fields.parentId} onChange={form.set('parentId')} hint="Leave empty for a main category.">
          <option value="">None (main category)</option>
          {parents
            .filter((p) => p.id !== category?.id)
            .map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
        </Field>
        <Field label="Sort order" type="number" min={0} max={9999} value={form.values.sortOrder} error={form.fields.sortOrder} onChange={form.set('sortOrder')} hint="Lower numbers are listed first." />
        {editing && <Checkbox label="Active" hint="Inactive categories cannot be chosen for new products." checked={form.values.isActive} onChange={form.set('isActive')} />}
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

export default function CategoriesPage() {
  const can = useCan();
  const { data, error, loading, reload } = useFetch('/categories');
  const [editing, setEditing] = useState(undefined); // undefined = closed, null = new

  const categories = data?.categories || [];
  const parents = categories.filter((c) => c.parentId === null);
  // Main categories, each followed by its sub-categories.
  const rows = parents.flatMap((p) => [p, ...categories.filter((c) => c.parentId === p.id)]);

  return (
    <>
      <div className="page-head with-actions">
        <div>
          <h1>Categories</h1>
          <p>Groups for products, two levels deep.</p>
        </div>
        {can('catalog.manage') && (
          <button className="btn btn-primary" onClick={() => setEditing(null)}>
            Add category
          </button>
        )}
      </div>

      <Notice>{error?.message}</Notice>
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>Name</th>
              <th className="num">Active products</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => (
              <tr key={c.id} className={c.isActive ? '' : 'inactive'}>
                <td className={c.parentId ? 'indent' : ''}>{c.parentId ? c.name : <strong>{c.name}</strong>}</td>
                <td className="num">{c.productCount}</td>
                <td>{c.isActive ? <span className="badge badge-ok">Active</span> : <span className="badge badge-muted">Inactive</span>}</td>
                <td className="num">
                  {can('catalog.manage') && (
                    <button className="btn btn-ghost btn-sm" onClick={() => setEditing(c)}>
                      Edit
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!loading && rows.length === 0 && <div className="empty">No categories yet. Add one before adding products.</div>}
      </div>

      {editing !== undefined && (
        <CategoryForm
          category={editing}
          parents={parents}
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
