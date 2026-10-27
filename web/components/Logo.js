/* eslint-disable @next/next/no-img-element */

// The shop's mark (the Owner's own SVG, web/public/brand/ssctc-mark.svg) with
// the name set beside it in the logo's colours. Everything scales with `height`,
// so it stays sharp from the 32px top bar to a printed invoice.
export default function Logo({ height = 44 }) {
  return (
    <span className="logo" role="img" aria-label="SS Computer Training Centre" style={{ height, fontSize: height * 0.34 }}>
      <img src="/brand/ssctc-mark.svg" alt="" height={height} style={{ height, width: 'auto' }} />
      <span className="logo-name" aria-hidden="true">
        <b>SS COMPUTER</b>
        <span>TRAINING CENTRE</span>
      </span>
    </span>
  );
}
