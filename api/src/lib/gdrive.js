const fs = require('node:fs');
const { env } = require('../config/env');

/**
 * Google Drive, for the nightly backup copy. Uses the Drive REST API directly
 * (no SDK) with an OAuth refresh token for the shop's Google account, made once
 * by `npm run gdrive-setup` (scripts/gdrive-setup.js). Its scope is drive.file: the application sees and
 * changes only the files it created itself, never anything else in the Drive.
 */

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';

const driveConfigured = () => Boolean(env.GDRIVE_CLIENT_ID && env.GDRIVE_CLIENT_SECRET && env.GDRIVE_REFRESH_TOKEN && env.GDRIVE_FOLDER_ID);

async function failure(res, what) {
  let detail = '';
  try {
    const body = await res.json();
    detail = (body.error && (body.error.message || body.error_description || body.error)) || body.error_description || '';
  } catch {
    // Not JSON.
  }
  return new Error(`Google Drive: ${what} failed (HTTP ${res.status}${detail ? `: ${detail}` : ''})`);
}

/** A short-lived access token from the stored refresh token. */
async function accessToken() {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: env.GDRIVE_CLIENT_ID, client_secret: env.GDRIVE_CLIENT_SECRET, refresh_token: env.GDRIVE_REFRESH_TOKEN, grant_type: 'refresh_token' }),
  });
  if (!res.ok) throw await failure(res, 'sign-in');
  return (await res.json()).access_token;
}

/**
 * Upload a local file into the backup folder. A resumable upload, so a file of
 * any size goes up in one request after the session is opened. Returns { id, name, size }.
 */
async function uploadFile(token, filePath, name, mimeType = 'application/gzip') {
  const size = fs.statSync(filePath).size;
  const start = await fetch(`${UPLOAD}/files?uploadType=resumable&fields=id,name,size`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': mimeType, 'X-Upload-Content-Length': String(size) },
    body: JSON.stringify({ name, parents: [env.GDRIVE_FOLDER_ID] }),
  });
  if (!start.ok) throw await failure(start, 'starting the upload');
  const session = start.headers.get('location');
  if (!session) throw new Error('Google Drive: no upload address was returned.');

  // fetch sets Content-Length itself from the buffer.
  const put = await fetch(session, { method: 'PUT', headers: { 'Content-Type': mimeType }, body: fs.readFileSync(filePath) });
  if (!put.ok) throw await failure(put, 'uploading');
  const file = await put.json();
  if (Number(file.size) !== size) throw new Error(`Google Drive: the uploaded file is ${file.size} bytes, expected ${size}.`);
  return file;
}

/** The files in the backup folder (only those this application made). [{ id, name }] */
async function listFolder(token) {
  const files = [];
  let pageToken = '';
  do {
    const q = encodeURIComponent(`'${env.GDRIVE_FOLDER_ID}' in parents and trashed = false`);
    const res = await fetch(`${API}/files?q=${q}&fields=nextPageToken,files(id,name)&pageSize=1000${pageToken ? `&pageToken=${pageToken}` : ''}`, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw await failure(res, 'listing the backup folder');
    const body = await res.json();
    files.push(...body.files);
    pageToken = body.nextPageToken || '';
  } while (pageToken);
  return files;
}

async function deleteFile(token, id) {
  const res = await fetch(`${API}/files/${encodeURIComponent(id)}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok && res.status !== 404) throw await failure(res, 'removing an old backup');
}

module.exports = { driveConfigured, accessToken, uploadFile, listFolder, deleteFile };
