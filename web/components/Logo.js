/* eslint-disable @next/next/no-img-element */

// The logo artwork has a white background, so it always sits on a white surface.
export default function Logo({ height = 44 }) {
  return <img src="/brand/ssctc-logo.png" alt="SS Computer Training Centre" height={height} style={{ height, width: 'auto', display: 'block' }} />;
}
