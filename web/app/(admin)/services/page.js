'use client';

import { useState } from 'react';
import CommissionRate, { describeRate, rateBody } from '@/components/CommissionRate';
import Modal from '@/components/Modal';
import { Checkbox, Field, Notice, SubmitButton } from '@/components/Form';
import { api } from '@/lib/api';
import { formatMoney } from '@/lib/format';
import { useCan } from '@/lib/session';
import { useFetch, useForm } from '@/lib/useFetch';

const TYPES = { print: 'Printing', photocopy: 'Photocopy', online: 'Online service', other: 'Other' };

function ServiceForm({ service, onDone, onClose }) {
  const editing = Boolean(service);
  const form = useForm(
    {
      serviceType: service?.serviceType || 'print',
      name: service?.name || '',
      unit: service?.unit || 'page',
      defaultPrice: service?.defaultPrice || '',
      priceEditable: service?.priceEditable ?? true,
      isActive: service?.isActive ?? true,
      sortOrder: service?.sortOrder ?? 0,
      commissionType: service?.commissionType || '',
      commissionValue: service?.commissionType ? String(Number(service.commissionValue)) : '',
    },
    async (v) => {
      const body = { serviceType: v.serviceType, name: v.name, unit: v.unit, defaultPrice: v.defaultPrice, priceEditable: v.priceEditable, sortOrder: Number(v.sortOrder) || 0, ...rateBody(v) };
      if (editing) await api.put(`/services/${service.id}`, { ...body, isActive: v.isActive });
      else await api.post('/services', body);
      onDone();
    },
  );

  return (
    <Modal title={editing ? 'Edit service' : 'Add service'} onClose={onClose}>
      <form onSubmit={form.onSubmit} noValidate>
        <Notice>{form.error}</Notice>
        <Field label="Service name" autoFocus required maxLength={150} placeholder="e.g. Photocopy A4 B/W" value={form.values.name} error={form.fields.name} onChange={form.set('name')} />
        <div className="form-grid">
          <Field as="select" label="Type" value={form.values.serviceType} error={form.fields.serviceType} onChange={form.set('serviceType')}>
            {Object.entries(TYPES).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </Field>
          <Field label="Billing unit" required maxLength={20} placeholder="page, copy, file, set" value={form.values.unit} error={form.fields.unit} onChange={form.set('unit')} />
          <Field label="Rate (৳ per unit)" inputMode="decimal" required value={form.values.defaultPrice} error={form.fields.defaultPrice} onChange={form.set('defaultPrice')} />
          <Field label="Sort order" type="number" min={0} max={9999} value={form.values.sortOrder} error={form.fields.sortOrder} onChange={form.set('sortOrder')} />
        </div>
        <CommissionRate form={form} unit={form.values.unit || 'unit'} />
        <Checkbox label="Price can be changed at the counter" hint="Turn off to always charge the listed rate." checked={form.values.priceEditable} onChange={form.set('priceEditable')} />
        {editing && <Checkbox label="Active" hint="Inactive services cannot be sold." checked={form.values.isActive} onChange={form.set('isActive')} />}
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

export default function ServicesPage() {
  const can = useCan();
  const { data, error, loading, reload } = useFetch('/services');
  const [editing, setEditing] = useState(undefined);
  const services = data?.services || [];

  return (
    <>
      <div className="page-head with-actions">
        <div>
          <h1>Services</h1>
          <p>The rate list for printing, photocopy, online and other services.</p>
        </div>
        {can('catalog.manage') && (
          <button className="btn btn-primary" onClick={() => setEditing(null)}>
            Add service
          </button>
        )}
      </div>

      <Notice>{error?.message}</Notice>
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>Service</th>
              <th>Type</th>
              <th className="num">Rate</th>
              <th>Counter price</th>
              <th>Commission</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {services.map((s) => (
              <tr key={s.id} className={s.isActive ? '' : 'inactive'}>
                <td>
                  <strong>{s.name}</strong>
                </td>
                <td>{TYPES[s.serviceType]}</td>
                <td className="num">
                  {formatMoney(s.defaultPrice)} <span className="sub">per {s.unit}</span>
                </td>
                <td>{s.priceEditable ? 'Can be changed' : 'Fixed'}</td>
                <td>{describeRate(s.commissionType, s.commissionValue, s.unit)}</td>
                <td>{s.isActive ? <span className="badge badge-ok">Active</span> : <span className="badge badge-muted">Inactive</span>}</td>
                <td className="num">
                  {can('catalog.manage') && (
                    <button className="btn btn-ghost btn-sm" onClick={() => setEditing(s)}>
                      Edit
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!loading && services.length === 0 && <div className="empty">No services yet.</div>}
      </div>

      {editing !== undefined && (
        <ServiceForm
          service={editing}
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
