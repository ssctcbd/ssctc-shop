// Connect the nightly backup to the shop's Google Drive. Run once, on your own
// PC (not on the server), in the api folder:
//
//   npm run gdrive-setup
//
// You need a Google Cloud OAuth client of type "Desktop app" (DEPLOYMENT_PLAN.md
// §5 has the steps). The script asks for its client ID and secret, opens
// Google's consent page in the browser, creates a folder "SSCTC Shop backups"
// in that account's My Drive, and prints four lines to add to the Node.js
// application's environment variables on cPanel.
//
// The access asked for is drive.file: the application can see and change only
// the files it creates itself, nothing else in the Drive. It does not read the
// application's .env and connects to no database.
const crypto = require('node:crypto');
const http = require('node:http');
const readline = require('node:readline');
const { execFile } = require('node:child_process');

const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const FOLDER_NAME = 'SSCTC Shop backups';

/** fetch, tried again when the connection itself fails: Google's code works only once, so a brief network drop must not waste it. */
async function fetchWithRetry(url, options, attempts = 5) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fetch(url, options);
    } catch (err) {
      if (attempt >= attempts) throw err;
      console.log('Connection problem, trying again...');
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }
}

function ask(rl, question) {
  return new Promise((resolve) => rl.question(question, (answer) => resolve(answer.trim())));
}

/** Wait for Google to send the browser back to us with the code. */
function waitForCode(server, state) {
  return new Promise((resolve, reject) => {
    server.on('request', (req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname !== '/') return res.writeHead(404).end();
      const done = (message) => res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(`<p style="font:18px sans-serif;margin:40px">${message}</p>`);
      if (url.searchParams.get('state') !== state) return done('This page did not come from this setup. Close it.');
      if (url.searchParams.get('error')) {
        done('Not allowed. You can close this page.');
        return reject(new Error(`Google said: ${url.searchParams.get('error')}`));
      }
      done('Done. Go back to the setup window; you can close this page.');
      resolve(url.searchParams.get('code'));
    });
  });
}

async function main() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const clientId = await ask(rl, 'OAuth client ID: ');
  const clientSecret = await ask(rl, 'OAuth client secret: ');
  rl.close();
  if (!clientId || !clientSecret) throw new Error('Both the client ID and the secret are needed.');

  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const redirectUri = `http://127.0.0.1:${server.address().port}`;
  const state = crypto.randomBytes(16).toString('hex');
  const verifier = crypto.randomBytes(48).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');

  const consent = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  for (const [k, v] of Object.entries({ client_id: clientId, redirect_uri: redirectUri, response_type: 'code', scope: SCOPE, access_type: 'offline', prompt: 'consent', state, code_challenge: challenge, code_challenge_method: 'S256' })) consent.searchParams.set(k, v);

  console.log('\nOpen this address, log in with the shop\'s Google account and allow access:\n');
  console.log(consent.href, '\n');
  if (process.platform === 'win32') execFile('rundll32', ['url.dll,FileProtocolHandler', consent.href], () => {});

  let code;
  try {
    code = await waitForCode(server, state);
  } finally {
    server.close();
  }

  const tokenRes = await fetchWithRetry('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, grant_type: 'authorization_code', code_verifier: verifier }),
  });
  const tokens = await tokenRes.json();
  if (!tokenRes.ok) throw new Error(`Google did not give a token: ${tokens.error_description || tokens.error}`);
  if (!tokens.refresh_token) throw new Error('Google gave no refresh token. Remove the app at myaccount.google.com/permissions and run this again.');

  const folderRes = await fetchWithRetry('https://www.googleapis.com/drive/v3/files?fields=id', {
    method: 'POST',
    headers: { Authorization: `Bearer ${tokens.access_token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: FOLDER_NAME, mimeType: 'application/vnd.google-apps.folder' }),
  });
  const folder = await folderRes.json();
  if (!folderRes.ok) throw new Error(`Could not create the folder: ${folder.error && folder.error.message}`);

  console.log(`Connected. The folder "${FOLDER_NAME}" is now in that account's Google Drive.\n`);
  console.log('Add these four to the Node.js application\'s environment variables on cPanel, then Restart.');
  console.log('Keep them private: with them anyone can put files in that folder.\n');
  console.log(`GDRIVE_CLIENT_ID=${clientId}`);
  console.log(`GDRIVE_CLIENT_SECRET=${clientSecret}`);
  console.log(`GDRIVE_REFRESH_TOKEN=${tokens.refresh_token}`);
  console.log(`GDRIVE_FOLDER_ID=${folder.id}`);
}

main().catch((err) => {
  console.error(`\nSetup failed: ${err.message}`);
  process.exitCode = 1;
});
