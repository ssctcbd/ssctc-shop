// Test environment. Integration tests need a real MySQL 8 server and a scratch
// database that they DROP and re-create, so the database name must end in "_test".
//
//   TEST_DB_HOST (127.0.0.1)  TEST_DB_PORT (3306)  TEST_DB_USER (root)
//   TEST_DB_PASSWORD ()       TEST_DB_NAME (ssctc_shop_test)
//
// Must be required before anything under src/, because src/config/env reads
// process.env once at load.
const fs = require('node:fs');
const path = require('node:path');

const DB_NAME = process.env.TEST_DB_NAME || 'ssctc_shop_test';
if (!DB_NAME.endsWith('_test')) throw new Error('TEST_DB_NAME must end in "_test"; the test suite drops this database.');

Object.assign(process.env, {
  NODE_ENV: 'test',
  PORT: '0',
  APP_BASE_URL: 'http://shop.test',
  API_BASE_PATH: '/api',
  CORS_ORIGIN: '',
  TRUST_PROXY: '0',
  DB_HOST: process.env.TEST_DB_HOST || '127.0.0.1',
  DB_PORT: process.env.TEST_DB_PORT || '3306',
  DB_USER: process.env.TEST_DB_USER || 'root',
  DB_PASSWORD: process.env.TEST_DB_PASSWORD || '',
  DB_NAME,
  BCRYPT_COST: '4', // fast hashing; production uses 12
  SESSION_HOURS: '12',
  SESSION_IDLE_HOURS: '2',
});

const mysql = require('mysql2/promise');

const ORIGIN = 'http://shop.test';
const read = (...parts) => fs.readFileSync(path.join(__dirname, '..', '..', ...parts), 'utf8');

function rawConnection(database) {
  return mysql.createConnection({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database,
    multipleStatements: true,
    connectTimeout: 3000,
  });
}

async function runSqlFiles(conn, dir) {
  for (const file of fs.readdirSync(path.join(__dirname, '..', '..', dir)).sort()) await conn.query(read(dir, file));
}

/** Drop and rebuild the test database from the real migration and seed files. */
async function resetDatabase() {
  const conn = await rawConnection();
  try {
    await conn.query(`DROP DATABASE IF EXISTS \`${DB_NAME}\`; CREATE DATABASE \`${DB_NAME}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci; USE \`${DB_NAME}\``);
    await runSqlFiles(conn, 'migrations');
    await runSqlFiles(conn, 'seeds');
  } finally {
    await conn.end();
  }
}

/** Run the seed files again on the existing test database. */
async function runSeeds() {
  const conn = await rawConnection(DB_NAME);
  try {
    await runSqlFiles(conn, 'seeds');
  } finally {
    await conn.end();
  }
}

/** Start the app on a free port. Returns helpers for making requests. */
async function startApp() {
  const { createApp } = require('../../src/app');
  const server = await new Promise((resolve) => {
    const s = createApp().listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;

  /** A client that keeps cookies between requests, like one browser. */
  function client() {
    const jar = new Map();
    async function request(method, url, body, headers = {}) {
      const res = await fetch(base + url, {
        method,
        headers: {
          ...(method === 'GET' ? {} : { Origin: ORIGIN }),
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(jar.size ? { Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') } : {}),
          ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      for (const line of res.headers.getSetCookie()) {
        const [pair] = line.split(';');
        const eq = pair.indexOf('=');
        const name = pair.slice(0, eq);
        const value = pair.slice(eq + 1);
        if (value === '' || /expires=Thu, 01 Jan 1970/i.test(line)) jar.delete(name);
        else jar.set(name, value);
      }
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : null, setCookie: res.headers.getSetCookie() };
    }
    return {
      jar,
      get: (url, headers) => request('GET', url, undefined, headers),
      post: (url, body, headers) => request('POST', url, body, headers),
      put: (url, body, headers) => request('PUT', url, body, headers),
    };
  }

  async function stop() {
    await new Promise((resolve) => server.close(resolve));
    await require('../../src/db/pool').pool.end();
  }

  return { base, client, stop };
}

module.exports = { resetDatabase, runSeeds, startApp, ORIGIN };
