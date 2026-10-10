// Runs after `next build`.
//
// Next.js 16 writes each page's navigation payload into nested folders, e.g.
//   out/dashboard/__next.!KGFkbWluKQ/dashboard/__PAGE__.txt
// but the browser asks for it under a dotted name in the page's folder:
//   /dashboard/__next.!KGFkbWluKQ.dashboard.__PAGE__.txt
// A plain web server (Apache/LiteSpeed on cPanel) cannot map one to the other,
// so links would 404 on prefetch and fall back to full page reloads. This copies
// every payload to the name the browser requests.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'out');
let copied = 0;

function flatten(routeDir, dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) flatten(routeDir, full);
    else {
      const flatName = path.relative(routeDir, full).split(path.sep).join('.');
      fs.copyFileSync(full, path.join(routeDir, flatName));
      copied++;
    }
  }
}

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const full = path.join(dir, entry.name);
    if (entry.name.startsWith('__next.')) flatten(dir, full);
    else if (entry.name !== '_next') walk(full);
  }
}

if (!fs.existsSync(OUT)) {
  console.error('postbuild: web/out not found — did `next build` run?');
  process.exit(1);
}
walk(OUT);
console.log(`postbuild: wrote ${copied} navigation payload file(s) under the names browsers request.`);
