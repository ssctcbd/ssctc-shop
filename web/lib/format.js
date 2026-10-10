const taka = new Intl.NumberFormat('en-BD', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const dateTime = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Dhaka', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true });
const dateOnly = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Dhaka', day: '2-digit', month: 'short', year: 'numeric' });

/** Money arrives from the API as a decimal string ("230.00"); format it for display only. */
export function formatMoney(value) {
  return `৳ ${taka.format(Number(value || 0))}`;
}

/** Timestamps arrive in UTC and are shown in shop time (Asia/Dhaka). */
export const formatDateTime = (value) => (value ? dateTime.format(new Date(value)) : '');
export const formatDate = (value) => (value ? dateOnly.format(new Date(value)) : '');

/**
 * Line total for on-screen previews, in whole paisa to avoid float drift.
 * The server recalculates every amount; this is display only.
 */
export function lineTotal(unitPrice, quantity) {
  const paisa = Math.round(Number(unitPrice || 0) * 100) * Math.trunc(Number(quantity || 0));
  return (paisa / 100).toFixed(2);
}

export const sumMoney = (amounts) => (amounts.reduce((sum, a) => sum + Math.round(Number(a || 0) * 100), 0) / 100).toFixed(2);
