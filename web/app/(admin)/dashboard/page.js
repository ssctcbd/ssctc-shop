'use client';

import Link from 'next/link';
import { Notice } from '@/components/Form';
import { formatDateTime, formatMoney } from '@/lib/format';
import { useStaff } from '@/lib/session';
import { useFetch } from '@/lib/useFetch';

/** Money that may be negative (a loss, a shortfall). */
const signed = (value) => (Number(value) < 0 ? `− ${formatMoney(Math.abs(Number(value)))}` : formatMoney(value));

function Stat({ label, value, href, linkText, tone = '', sub }) {
  return (
    <div className={`stat ${tone}`}>
      <span>{label}</span>
      <b>{value}</b>
      {sub && <small className="muted">{sub}</small>}
      {href && <Link href={href}>{linkText}</Link>}
    </div>
  );
}

// Each block comes from the API only if the user's role covers it, so the
// page simply draws what it is given.
export default function DashboardPage() {
  const user = useStaff();
  const { data: d, error } = useFetch('/dashboard');

  return (
    <>
      <div className="page-head">
        <h1>Welcome, {user.name}</h1>
        <p>
          You are logged in as <span className="badge">{user.role.name}</span> · today&apos;s figures
        </p>
      </div>

      <Notice>{error?.message}</Notice>
      {d && (
        <>
          {/* A copy in Google Drive from the last two nights counts as a copy away from the server. */}
          {d.backup && !(d.backup.lastDriveAt && Date.now() - new Date(d.backup.lastDriveAt).getTime() < 2 * 86400000) && (!d.backup.lastDownloadAt || Date.now() - new Date(d.backup.lastDownloadAt).getTime() > 7 * 86400000) && (
            <Notice kind="warning">
              {d.backup.lastDownloadAt ? 'No backup has been downloaded for over a week.' : 'No backup of the shop records has been downloaded yet.'} <Link href="/system/">Download one now</Link>
            </Notice>
          )}
          {d.backup && d.backup.lastRunOk === false && (
            <Notice>
              Last night&apos;s automatic backup failed. <Link href="/system/">See details</Link>
            </Notice>
          )}
          <div className="grid">
            {d.sales && <Stat label="Today's sales" value={formatMoney(d.sales.netSales)} sub={`${d.sales.bills} bill(s)`} href="/sales/" linkText="See sales" />}
            {d.payments && <Stat label="Collected today" value={formatMoney(d.payments.collectedToday)} href="/payments/" linkText="See payments" />}
            {d.sales && <Stat label="New dues today" value={formatMoney(d.sales.newDues)} tone={Number(d.sales.newDues) > 0 ? 'due' : ''} />}
            {d.expensesToday !== undefined && <Stat label="Today's expenses" value={formatMoney(d.expensesToday)} href="/expenses/" linkText="See expenses" />}
            {d.profit && (
              <Stat
                label="Estimated profit today"
                value={signed(d.profit.netProfit)}
                tone={Number(d.profit.netProfit) < 0 ? 'due' : 'ok'}
                sub={`Gross ${signed(d.profit.grossProfit)}${Number(d.profit.commission) > 0 ? ` − commission ${formatMoney(d.profit.commission)}` : ''} − expenses ${formatMoney(d.profit.expenses)}${d.profit.uncostedLines > 0 ? ' · some items have no cost price' : ''}`}
              />
            )}
            {d.cash &&
              (d.cash.status === 'open' ? (
                <Stat
                  label="Cash that should be in the drawer"
                  value={signed(d.cash.expected)}
                  tone={d.cash.stale ? 'due' : ''}
                  sub={d.cash.stale ? 'Yesterday was never handed over: close it first' : 'The cash is open'}
                  href="/cash/"
                  linkText={d.cash.stale ? 'Close it now' : 'Hand over tonight'}
                />
              ) : (
                <Stat
                  label="Cash in the drawer"
                  value={d.cash.carried === null ? '—' : formatMoney(d.cash.carried)}
                  tone="due"
                  sub={d.cash.lastClosingDate ? 'Handed over. Open the cash before the first sale.' : 'Open the cash before the first sale.'}
                  href="/cash/"
                  linkText="Open the cash"
                />
              ))}
            {d.myCommission && <Stat label="My commission today" value={signed(d.myCommission.earnedToday)} tone="ok" sub={`Still to be paid: ${signed(d.myCommission.balance)}`} href="/commission/" linkText="See my commission" />}
          </div>

          <div className="grid">
            {d.dues && <Stat label="Customers owe the shop" value={formatMoney(d.dues.total)} tone={Number(d.dues.total) > 0 ? 'due' : ''} sub={`${d.dues.customers} customer(s)`} href="/dues/" linkText="Collect dues" />}
            {d.payables && <Stat label="The shop owes suppliers" value={formatMoney(d.payables.total)} sub={`${d.payables.suppliers} supplier(s)`} href="/suppliers/" linkText="See suppliers" />}
            {d.payments && (
              <Stat
                label="Payments waiting to be verified"
                value={d.payments.unverifiedCount}
                tone={d.payments.unverifiedCount > 0 ? 'due' : ''}
                sub={d.payments.unverifiedCount > 0 ? formatMoney(d.payments.unverifiedAmount) : 'Nothing waiting'}
                href="/payments/"
                linkText="See payments"
              />
            )}
            {d.lowStock !== undefined && <Stat label="Low-stock products" value={d.lowStock} tone={d.lowStock > 0 ? 'due' : ''} href="/inventory/" linkText="See the list" />}
          </div>

          <div className="cash-columns">
            {d.recentSales && (
              <div>
                <h2 className="section-title">Recent sales</h2>
                <div className="table-wrap">
                  <table className="data">
                    <tbody>
                      {d.recentSales.map((s) => (
                        <tr key={s.id} className={s.status === 'void' ? 'inactive' : ''}>
                          <td>
                            <Link href={`/sales/invoice/?id=${s.id}`}>
                              <strong>{s.invoiceNo}</strong>
                            </Link>
                            <span className="sub">
                              {s.customerName || 'Walk-in'} · {formatDateTime(s.saleDate)}
                            </span>
                          </td>
                          <td className="num">
                            {formatMoney(s.totalAmount)}
                            {s.status === 'void' ? <span className="sub">Void</span> : Number(s.dueAmount) > 0 && <span className="sub qty-out">Due {formatMoney(s.dueAmount)}</span>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {d.recentSales.length === 0 && <div className="empty">No sales yet.</div>}
                </div>
              </div>
            )}
            {d.dues && (
              <div>
                <h2 className="section-title">Who owes the most</h2>
                <div className="table-wrap">
                  <table className="data">
                    <tbody>
                      {d.dues.top.map((c) => (
                        <tr key={c.id}>
                          <td>
                            <strong>{c.name}</strong>
                            <span className="sub">{c.phone}</span>
                          </td>
                          <td className="num qty-out">{formatMoney(c.currentDue)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {d.dues.top.length === 0 && <div className="empty">Nobody owes the shop anything.</div>}
                </div>
              </div>
            )}
          </div>
        </>
      )}
    </>
  );
}
