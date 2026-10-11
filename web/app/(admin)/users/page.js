'use client';

import { useState } from 'react';
import Modal from '@/components/Modal';
import { Field, Notice, SubmitButton } from '@/components/Form';
import { api } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { useStaff } from '@/lib/session';
import { useFetch, useForm } from '@/lib/useFetch';

const ROLES = { owner: 'Owner', staff: 'Staff' };
const ROLE_HINT = { owner: 'Can do everything, including this screen.', staff: 'Sells, takes payments, records expenses, sees stock. Cannot void, verify or change prices.' };

function UserForm({ user, isSelf, onDone, onClose }) {
  const editing = Boolean(user);
  const form = useForm({ name: user?.name || '', username: '', phone: user?.phone || '', role: user?.role || 'staff', password: '' }, async (v) => {
    if (editing) await api.put(`/users/${user.id}`, { name: v.name, phone: v.phone || null, ...(isSelf ? {} : { role: v.role }) });
    else await api.post('/users', { name: v.name, username: v.username, ...(v.phone ? { phone: v.phone } : {}), role: v.role, password: v.password });
    onDone();
  });
  const { values: v, fields: f, set } = form;

  return (
    <Modal title={editing ? `Edit ${user.username}` : 'Add user'} onClose={onClose}>
      <form onSubmit={form.onSubmit} noValidate>
        <Notice>{form.error}</Notice>
        <Field label="Full name" autoFocus required maxLength={120} value={v.name} error={f.name} onChange={set('name')} />
        {!editing && <Field label="Username" required maxLength={60} autoCapitalize="none" value={v.username} error={f.username} onChange={set('username')} hint="What they type to log in. Small letters and numbers, no spaces." />}
        <Field label="Mobile" type="tel" maxLength={15} value={v.phone} error={f.phone} onChange={set('phone')} />
        <Field as="select" label="Role" value={v.role} error={f.role} onChange={set('role')} disabled={isSelf} hint={isSelf ? 'You cannot change your own role.' : ROLE_HINT[v.role]}>
          {Object.entries(ROLES).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </Field>
        {!editing && <Field label="First password" type="text" required autoComplete="off" value={v.password} error={f.password} onChange={set('password')} hint="At least 10 characters. Tell it to them; they must choose their own at first login." />}
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

function ResetPasswordForm({ user, onDone, onClose }) {
  const [saved, setSaved] = useState(false);
  const form = useForm({ password: '' }, async (v) => {
    await api.post(`/users/${user.id}/reset-password`, { password: v.password });
    setSaved(true);
  });

  return (
    <Modal title={`New password for ${user.name}`} onClose={saved ? onDone : onClose}>
      {saved ? (
        <>
          <Notice kind="success">
            Password changed. Tell {user.name} the new password: <strong className="pin-text">{form.values.password}</strong>. They are logged out everywhere and must choose their own at the next login.
          </Notice>
          <div className="form-actions">
            <button className="btn btn-primary" onClick={onDone}>
              Done
            </button>
          </div>
        </>
      ) : (
        <form onSubmit={form.onSubmit} noValidate>
          <Notice>{form.error !== 'Please check the highlighted fields.' && form.error}</Notice>
          <Field label="New password" type="text" autoFocus required autoComplete="off" value={form.values.password} error={form.fields.password} onChange={form.set('password')} hint="At least 10 characters. For someone who forgot theirs." />
          <div className="form-actions">
            <button type="button" className="btn btn-ghost" onClick={onClose}>
              Cancel
            </button>
            <SubmitButton busy={form.busy} block={false}>
              Set password
            </SubmitButton>
          </div>
        </form>
      )}
    </Modal>
  );
}

export default function UsersPage() {
  const me = useStaff();
  const { data, error, loading, reload } = useFetch('/users');
  const [editing, setEditing] = useState(undefined);
  const [resetting, setResetting] = useState(null);
  const [actionError, setActionError] = useState('');
  const users = data?.users || [];

  async function setStatus(user, status) {
    if (status === 'blocked' && !window.confirm(`Block ${user.name}? They are logged out at once and cannot log in until unblocked.`)) return;
    setActionError('');
    try {
      await api.put(`/users/${user.id}`, { status });
      reload();
    } catch (err) {
      setActionError(err.message);
    }
  }

  return (
    <>
      <div className="page-head with-actions">
        <div>
          <h1>Users</h1>
          <p>Who can log in to the shop system, and as what.</p>
        </div>
        <button className="btn btn-primary" onClick={() => setEditing(null)}>
          Add user
        </button>
      </div>

      <Notice>{error?.message || actionError}</Notice>
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>User</th>
              <th>Role</th>
              <th>Last login</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id} className={u.status === 'blocked' ? 'inactive' : ''}>
                <td>
                  <strong>{u.name}</strong>
                  {u.id === me.id && <span className="badge badge-muted">You</span>}
                  <span className="sub">{[u.username, u.phone].filter(Boolean).join(' · ')}</span>
                </td>
                <td>
                  <span className="badge">{ROLES[u.role]}</span>
                  {u.status === 'blocked' && <span className="badge badge-danger">Blocked</span>}
                  {u.mustChangePassword && <span className="sub">Must change password</span>}
                </td>
                <td className="nowrap">{u.lastLoginAt ? formatDateTime(u.lastLoginAt) : 'Never'}</td>
                <td className="num nowrap">
                  <button className="btn btn-ghost btn-sm" onClick={() => setEditing(u)}>
                    Edit
                  </button>{' '}
                  {u.id !== me.id && (
                    <>
                      <button className="btn btn-ghost btn-sm" onClick={() => setResetting(u)}>
                        New password
                      </button>{' '}
                      {u.status === 'active' ? (
                        <button className="btn btn-danger-ghost btn-sm" onClick={() => setStatus(u, 'blocked')}>
                          Block
                        </button>
                      ) : (
                        <button className="btn btn-ghost btn-sm" onClick={() => setStatus(u, 'active')}>
                          Unblock
                        </button>
                      )}
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!loading && !error && users.length === 0 && <div className="empty">No users.</div>}
      </div>
      <p className="field-hint">A user is never deleted, because their name stays on the bills they made. Block someone who has left.</p>

      {editing !== undefined && (
        <UserForm
          user={editing}
          isSelf={editing?.id === me.id}
          onClose={() => setEditing(undefined)}
          onDone={() => {
            setEditing(undefined);
            reload();
          }}
        />
      )}
      {resetting && (
        <ResetPasswordForm
          user={resetting}
          onClose={() => setResetting(null)}
          onDone={() => {
            setResetting(null);
            reload();
          }}
        />
      )}
    </>
  );
}
