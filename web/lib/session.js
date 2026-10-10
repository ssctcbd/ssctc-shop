'use client';

import { createContext, useContext, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api } from './api';

// These guards only decide what to *show*. Every piece of data and every action
// is authorised again by the API; a visitor who bypasses a guard gets empty
// screens and 401 responses, nothing more.

const StaffContext = createContext(null);
const CustomerContext = createContext(null);

export const useStaff = () => useContext(StaffContext);
export const useCustomer = () => useContext(CustomerContext);

function useLoad(path, pick, loginPath) {
  const router = useRouter();
  const [state, setState] = useState({ status: 'loading', value: null, error: null });

  useEffect(() => {
    let cancelled = false;
    api
      .get(path)
      .then((data) => !cancelled && setState({ status: 'ready', value: pick(data), error: null }))
      .catch((error) => {
        if (cancelled) return;
        if (error.status === 401) router.replace(loginPath);
        else setState({ status: 'error', value: null, error });
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, loginPath]);

  return state;
}

function Gate({ state, children }) {
  if (state.status === 'ready') return children;
  return (
    <div className="center-screen">
      {state.status === 'error' ? (
        <div className="notice notice-error" role="alert">
          {state.error.message}{' '}
          <button className="link" onClick={() => window.location.reload()}>
            Try again
          </button>
        </div>
      ) : (
        <div className="spinner" role="status" aria-label="Loading" />
      )}
    </div>
  );
}

/** Wraps staff screens: loads the logged-in user or sends the visitor to /login/. */
export function StaffGate({ children }) {
  const state = useLoad('/auth/me', (d) => d.user, '/login/');
  return (
    <Gate state={state}>
      <StaffContext.Provider value={state.value}>{children}</StaffContext.Provider>
    </Gate>
  );
}

/** Wraps customer portal screens: loads the customer or sends them to /portal/login/. */
export function CustomerGate({ children }) {
  const state = useLoad('/portal/me', (d) => d.customer, '/portal/login/');
  return (
    <Gate state={state}>
      <CustomerContext.Provider value={state.value}>{children}</CustomerContext.Provider>
    </Gate>
  );
}
