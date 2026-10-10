'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from './api';

/**
 * Load `path` from the API and reload when it changes. Pass null to skip.
 * Returns { data, error, loading, reload }. Previous data stays visible while
 * a reload is in flight, so tables do not flicker.
 */
export function useFetch(path, { loginPath = '/login/' } = {}) {
  const [state, setState] = useState({ data: null, error: null, loading: Boolean(path) });
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!path) return undefined;
    let cancelled = false;
    setState((s) => ({ ...s, loading: true }));
    api
      .get(path)
      .then((data) => !cancelled && setState({ data, error: null, loading: false }))
      .catch((error) => {
        if (cancelled) return;
        // Session ended while the screen was open: back to the login page.
        if (error.status === 401) window.location.assign(loginPath);
        // The API refuses everything until a password set by the Owner is replaced.
        else if (error.code === 'password_change_required') window.location.assign('/account/');
        else setState((s) => ({ ...s, error, loading: false }));
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, tick]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { ...state, reload };
}

/** Build a query string, leaving out empty values. */
export function toQuery(params) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== '' && value !== null && value !== undefined && value !== false) search.set(key, value === true ? '1' : String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : '';
}

/**
 * State and submit handling shared by the create/edit forms: field values,
 * per-field errors from the API, a general error and a busy flag.
 */
export function useForm(initial, submit) {
  const [values, setValues] = useState(initial);
  const [fields, setFields] = useState({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const set = (name) => (event) => {
    const { type, checked, value } = event.target;
    setValues((v) => ({ ...v, [name]: type === 'checkbox' ? checked : value }));
  };

  async function onSubmit(event) {
    event.preventDefault();
    setError('');
    setFields({});
    setBusy(true);
    try {
      await submit(values);
    } catch (err) {
      setFields(err.fields || {});
      if (!err.fields || Object.keys(err.fields).length === 0) setError(err.message);
      else setError('Please check the highlighted fields.');
      setBusy(false);
    }
  }

  return { values, setValues, set, fields, error, busy, onSubmit };
}
