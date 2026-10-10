import Logo from './Logo';
import QrCode from './QrCode';
import { formatDate, formatDateTime, formatMoney } from '@/lib/format';

export const METHOD_LABELS = { cash: 'Cash', bkash: 'bKash', nagad: 'Nagad', bank_transfer: 'Bank transfer', customer_advance: 'Advance balance', other: 'Other' };

// Paper choices. The @page rule is what tells the printer driver the roll width.
export const LAYOUTS = {
  a4: { label: 'A4 page', page: 'A4', margin: '14mm' },
  thermal80: { label: 'Thermal 80mm', page: '80mm auto', margin: '3mm' },
  thermal58: { label: 'Thermal 58mm', page: '58mm auto', margin: '2mm' },
};

/**
 * A printed bill. Used for the staff invoice (with a paper layout and a QR
 * code) and for the bill a customer opens in the portal. It shows only what it
 * is given; what a customer may see is decided by the API.
 */
export default function Bill({ sale: s, shop = {}, layout = 'a4', qrUrl = null }) {
  const thermal = layout !== 'a4';
  const payments = s.payments.filter((p) => p.status === 'active');
  const shopName = shop['shop.name'] || 'SS Computer Training Centre';
  const hasReturns = Number(s.returnedAmount) > 0;

  return (
    <article className={`invoice ${thermal ? `invoice-thermal invoice-${layout}` : 'invoice-a4'}`}>
      {s.status === 'void' && <div className="invoice-void">VOID</div>}
      <header className="invoice-head">
        {!thermal && <Logo height={56} />}
        <div>
          <strong className="invoice-shop">{shopName}</strong>
          {shop['shop.tagline'] && <span>{shop['shop.tagline']}</span>}
          {shop['shop.address'] && <span>{shop['shop.address']}</span>}
          {shop['shop.phone'] && <span>Phone: {shop['shop.phone']}</span>}
        </div>
      </header>

      <div className="invoice-meta">
        <div>
          <span>Invoice</span>
          <strong>{s.invoiceNo}</strong>
        </div>
        <div>
          <span>Date</span>
          {formatDateTime(s.saleDate)}
        </div>
        <div>
          <span>Customer</span>
          {s.customerName || 'Walk-in'}
          {s.customerPhone ? ` · ${s.customerPhone}` : ''}
        </div>
      </div>

      <table className="invoice-items">
        <thead>
          <tr>
            <th>Item</th>
            <th className="num">Qty</th>
            <th className="num">Price</th>
            <th className="num">Total</th>
          </tr>
        </thead>
        <tbody>
          {s.items.map((i) => (
            <tr key={i.id}>
              <td>
                {i.name}
                {(i.warranty || i.serialNo) && <small>{[i.warranty && `Warranty: ${i.warranty}`, i.serialNo && `S/N: ${i.serialNo}`].filter(Boolean).join(' · ')}</small>}
                {i.returnedQuantity > 0 && <small>Returned: {i.returnedQuantity}</small>}
              </td>
              <td className="num">{i.quantity}</td>
              <td className="num">{Number(i.unitPrice).toFixed(2)}</td>
              <td className="num">{Number(i.lineTotal).toFixed(2)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="invoice-bottom">
        {qrUrl && <QrCode value={qrUrl} size={thermal ? 96 : 104} label="Scan to view this bill" />}
        <div className="invoice-totals">
          <div>
            <span>Subtotal</span>
            <span>{formatMoney(s.subtotal)}</span>
          </div>
          {Number(s.discountAmount) > 0 && (
            <div>
              <span>Discount</span>
              <span>− {formatMoney(s.discountAmount)}</span>
            </div>
          )}
          <div className="invoice-total">
            <span>Total</span>
            <span>{formatMoney(s.totalAmount)}</span>
          </div>
          {payments.map((p) => (
            <div key={p.id}>
              <span>
                {METHOD_LABELS[p.method] || p.method}
                {p.reference ? ` (${p.reference})` : ''}
                {p.isVerified ? '' : ' — not yet verified'}
              </span>
              <span>{formatMoney(p.amount)}</span>
            </div>
          ))}
          {hasReturns && (
            <>
              <div>
                <span>Returned goods</span>
                <span>− {formatMoney(s.returnedAmount)}</span>
              </div>
              {Number(s.refundedAmount) > 0 && (
                <div>
                  <span>Refunded to customer</span>
                  <span>{formatMoney(s.refundedAmount)}</span>
                </div>
              )}
            </>
          )}
          <div className="invoice-total">
            <span>Due</span>
            <span>{s.status === 'void' ? '—' : formatMoney(s.dueAmount)}</span>
          </div>
        </div>
      </div>

      {hasReturns && (
        <div className="invoice-returns">
          <strong>Returns</strong>
          {s.returns.map((r) => (
            <p key={r.id}>
              {r.returnNo} · {formatDate(r.returnDate)} · {r.items.map((i) => `${i.name} × ${i.quantity}`).join(', ')} · {formatMoney(r.returnAmount)}
              {Number(r.refundAmount) > 0 ? ` (${formatMoney(r.refundAmount)} ${r.refundMethod === 'cash' ? 'refunded in cash' : 'added to advance balance'})` : ' (taken off the due)'}
            </p>
          ))}
        </div>
      )}

      <footer className="invoice-foot">
        {(shop['payment.bkash_number'] || shop['payment.nagad_number']) && (
          <p>
            {shop['payment.bkash_number'] && `bKash: ${shop['payment.bkash_number']}`}
            {shop['payment.bkash_number'] && shop['payment.nagad_number'] && ' · '}
            {shop['payment.nagad_number'] && `Nagad: ${shop['payment.nagad_number']}`}
          </p>
        )}
        <p>{shop['invoice.footer']}</p>
        <p className="invoice-by">Served by {s.createdByName}</p>
      </footer>
    </article>
  );
}
