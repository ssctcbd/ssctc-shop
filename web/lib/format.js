const taka = new Intl.NumberFormat('en-BD', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Money arrives from the API as a decimal string ("230.00"); format it for display only. */
export function formatMoney(value) {
  return `৳ ${taka.format(Number(value || 0))}`;
}
