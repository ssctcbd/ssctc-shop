// Serve the static export the way production does: files from web/out, and
// /api/* passed through to the Express app, all on one origin.
//
//   npm run build && npm run preview
//   (API must be running: `npm start` in ../api, default http://localhost:4000)
//
// For local checking only. It is not used on the server.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'out');
const PORT = Number(process.env.PORT || 3000);
const API = new URL(process.env.API_TARGET || 'http://localhost:4000');

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.txt': 'text/plain', '.woff2': 'font/woff2' };

function proxy(req, res) {
  const upstream = http.request({ host: API.hostname, port: API.port, path: req.url, method: req.method, headers: { ...req.headers, host: API.host } }, (apiRes) => {
    res.writeHead(apiRes.statusCode, apiRes.headers);
    apiRes.pipe(res);
  });
  upstream.on('error', () => {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'bad_gateway', message: `API not reachable at ${API.origin}` } }));
  });
  req.pipe(upstream);
}

function serveFile(res, file, status = 200) {
  res.writeHead(status, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}

http
  .createServer((req, res) => {
    if (req.url.startsWith('/api/')) return proxy(req, res);

    const pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    let file = path.join(OUT, pathname);
    if (!file.startsWith(OUT)) return res.writeHead(403).end();
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
    if (fs.existsSync(file)) return serveFile(res, file);
    const notFound = [path.join(OUT, '404.html'), path.join(OUT, '404', 'index.html')].find((f) => fs.existsSync(f));
    if (notFound) return serveFile(res, notFound, 404);
    res.writeHead(404).end('Not found');
  })
  .listen(PORT, () => console.log(`Preview: http://localhost:${PORT}  (API → ${API.origin})`));
