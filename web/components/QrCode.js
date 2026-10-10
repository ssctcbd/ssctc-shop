'use client';

/* eslint-disable @next/next/no-img-element */
import { useEffect, useState } from 'react';
import QRCode from 'qrcode';

/** A QR code for `value`, drawn in the browser. Renders nothing until ready. */
export default function QrCode({ value, size = 110, label }) {
  const [src, setSrc] = useState('');

  useEffect(() => {
    let cancelled = false;
    // Medium error correction: still scans from a slightly smudged thermal print.
    QRCode.toDataURL(value, { errorCorrectionLevel: 'M', margin: 1, width: size * 3 })
      .then((url) => !cancelled && setSrc(url))
      .catch(() => !cancelled && setSrc(''));
    return () => {
      cancelled = true;
    };
  }, [value, size]);

  if (!src) return null;
  return (
    <div className="qr">
      <img src={src} alt={label || 'QR code'} width={size} height={size} />
      {label && <span>{label}</span>}
    </div>
  );
}
