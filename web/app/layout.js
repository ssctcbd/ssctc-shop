import './globals.css';

export const metadata = {
  title: { default: 'SSCTC Shop', template: '%s · SSCTC Shop' },
  description: 'SS Computer Training Centre — shop management',
  icons: { icon: '/brand/favicon.svg' },
  // Internal system: keep it out of search engines.
  robots: { index: false, follow: false },
};

export const viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#1146b0',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
