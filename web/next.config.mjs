/** @type {import('next').NextConfig} */
const nextConfig = {
  // Static export: `npm run build` writes plain files to web/out, which are
  // uploaded to the subdomain's document root. No Node server runs for the site.
  output: 'export',
  // /login/ is written as login/index.html, so the web server needs no rewrite rules.
  trailingSlash: true,
  // The image optimiser needs a server; images are served as they are.
  images: { unoptimized: true },
  reactStrictMode: true,
};

export default nextConfig;
