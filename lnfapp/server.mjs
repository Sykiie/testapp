import { createServer } from 'node:http';
import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const scrypt = promisify(scryptCallback);
const root = fileURLToPath(new URL('.', import.meta.url));
const publicDir = join(root, 'public');
const dataDir = join(root, 'data');
mkdirSync(dataDir, { recursive: true });
const db = new DatabaseSync(join(dataDir, 'lost-and-found.sqlite'));
db.exec(`
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS listings (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('lost', 'found')),
    title TEXT NOT NULL,
    category TEXT NOT NULL,
    description TEXT NOT NULL,
    location TEXT NOT NULL,
    item_date TEXT NOT NULL,
    contact_email TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS listings_search ON listings(kind, category, status, item_date);
`);

const mimeTypes = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };
const cookieName = 'lf_session';
const sessionLifetime = 7 * 24 * 60 * 60 * 1000;
const categories = new Set(['Electronics', 'Keys', 'Bags', 'Clothing', 'Cards & IDs', 'Jewelry', 'Books', 'Other']);

function json(res, status, data, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 20_000) {
        reject(Object.assign(new Error('Request is too large.'), { status: 413 }));
        req.destroy();
      }
    });
    req.on('end', () => {
      try { resolve(JSON.parse(body || '{}')); }
      catch { reject(Object.assign(new Error('Please send valid JSON.'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

function cookieValue(req, name) {
  const pair = (req.headers.cookie || '').split(';').map(part => part.trim()).find(part => part.startsWith(`${name}=`));
  return pair ? decodeURIComponent(pair.slice(name.length + 1)) : null;
}

function currentUser(req) {
  const token = cookieValue(req, cookieName);
  if (!token) return null;
  const tokenHash = createHash('sha256').update(token).digest('hex');
  const session = db.prepare('SELECT user_id FROM sessions WHERE token_hash = ? AND expires_at > ?').get(tokenHash, Date.now());
  if (!session) return null;
  return db.prepare('SELECT id, email FROM users WHERE id = ?').get(session.user_id) || null;
}

function sessionCookie(token, maxAgeSeconds) {
  return `${cookieName}=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}

function validateListing(input) {
  const value = {
    kind: String(input.kind || ''),
    title: String(input.title || '').trim(),
    category: String(input.category || ''),
    description: String(input.description || '').trim(),
    location: String(input.location || '').trim(),
    itemDate: String(input.itemDate || ''),
    contactEmail: String(input.contactEmail || '').trim().toLowerCase(),
  };
  if (!['lost', 'found'].includes(value.kind)) throw Object.assign(new Error('Choose whether the item was lost or found.'), { status: 400 });
  if (value.title.length < 2 || value.title.length > 90) throw Object.assign(new Error('Title must be between 2 and 90 characters.'), { status: 400 });
  if (!categories.has(value.category)) throw Object.assign(new Error('Choose a category from the list.'), { status: 400 });
  if (value.description.length < 5 || value.description.length > 1200) throw Object.assign(new Error('Description must be between 5 and 1,200 characters.'), { status: 400 });
  if (value.location.length < 2 || value.location.length > 120) throw Object.assign(new Error('Location must be between 2 and 120 characters.'), { status: 400 });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value.itemDate) || Number.isNaN(Date.parse(`${value.itemDate}T00:00:00Z`))) throw Object.assign(new Error('Enter a valid date.'), { status: 400 });
  if (value.contactEmail.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.contactEmail)) throw Object.assign(new Error('Enter a valid contact email.'), { status: 400 });
  return value;
}

function listingResponse(row, user) {
  return {
    id: row.id, kind: row.kind, title: row.title, category: row.category,
    description: row.description, location: row.location, itemDate: row.item_date,
    contactEmail: row.contact_email, status: row.status, createdAt: row.created_at,
    updatedAt: row.updated_at, isOwner: Boolean(user && row.user_id === user.id),
  };
}

async function api(req, res, url) {
  const user = currentUser(req);
  const path = url.pathname;

  if (req.method === 'GET' && path === '/api/me') return json(res, 200, { user: user ? { email: user.email } : null });

  if (req.method === 'POST' && path === '/api/register') {
    const body = await readBody(req);
    const email = String(body.email || '').trim().toLowerCase();
    const password = String(body.password || '');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) return json(res, 400, { error: 'Enter a valid email address.' });
    if (password.length < 10 || password.length > 200) return json(res, 400, { error: 'Use a password with at least 10 characters.' });
    const salt = randomBytes(16).toString('hex');
    const derived = await scrypt(password, salt, 64);
    let result;
    try { result = db.prepare('INSERT INTO users (email, password_hash) VALUES (?, ?)').run(email, `${salt}:${Buffer.from(derived).toString('hex')}`); }
    catch (error) {
      if (String(error.message).includes('UNIQUE')) return json(res, 409, { error: 'An account already exists for this email.' });
      throw error;
    }
    const token = randomBytes(32).toString('base64url');
    db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(createHash('sha256').update(token).digest('hex'), Number(result.lastInsertRowid), Date.now() + sessionLifetime);
    return json(res, 201, { user: { email } }, { 'Set-Cookie': sessionCookie(token, sessionLifetime / 1000) });
  }

  if (req.method === 'POST' && path === '/api/login') {
    const body = await readBody(req);
    const email = String(body.email || '').trim().toLowerCase();
    const password = String(body.password || '');
    const account = db.prepare('SELECT id, email, password_hash FROM users WHERE email = ?').get(email);
    let valid = false;
    if (account) {
      const [salt, savedHex] = account.password_hash.split(':');
      const candidate = Buffer.from(await scrypt(password, salt, 64));
      const saved = Buffer.from(savedHex, 'hex');
      valid = candidate.length === saved.length && timingSafeEqual(candidate, saved);
    }
    if (!valid) return json(res, 401, { error: 'Email or password is incorrect.' });
    const token = randomBytes(32).toString('base64url');
    db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(createHash('sha256').update(token).digest('hex'), account.id, Date.now() + sessionLifetime);
    return json(res, 200, { user: { email: account.email } }, { 'Set-Cookie': sessionCookie(token, sessionLifetime / 1000) });
  }

  if (req.method === 'POST' && path === '/api/logout') {
    const token = cookieValue(req, cookieName);
    if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(createHash('sha256').update(token).digest('hex'));
    return json(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie('', 0) });
  }

  if (req.method === 'GET' && path === '/api/listings') {
    const conditions = [];
    const values = [];
    const q = String(url.searchParams.get('q') || '').trim().slice(0, 100);
    const kind = url.searchParams.get('kind');
    const category = url.searchParams.get('category');
    const status = url.searchParams.get('status') || 'open';
    const location = String(url.searchParams.get('location') || '').trim().slice(0, 100);
    if (q) { conditions.push('(title LIKE ? OR description LIKE ? OR location LIKE ?)'); values.push(`%${q}%`, `%${q}%`, `%${q}%`); }
    if (['lost', 'found'].includes(kind)) { conditions.push('kind = ?'); values.push(kind); }
    if (categories.has(category)) { conditions.push('category = ?'); values.push(category); }
    if (['open', 'resolved'].includes(status)) { conditions.push('status = ?'); values.push(status); }
    if (location) { conditions.push('location LIKE ?'); values.push(`%${location}%`); }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const rows = db.prepare(`SELECT * FROM listings ${where} ORDER BY item_date DESC, id DESC LIMIT 100`).all(...values);
    return json(res, 200, { listings: rows.map(row => listingResponse(row, user)) });
  }

  if (req.method === 'POST' && path === '/api/listings') {
    if (!user) return json(res, 401, { error: 'Sign in to post an item.' });
    const value = validateListing(await readBody(req));
    const result = db.prepare(`INSERT INTO listings (user_id, kind, title, category, description, location, item_date, contact_email)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(user.id, value.kind, value.title, value.category, value.description, value.location, value.itemDate, value.contactEmail);
    const row = db.prepare('SELECT * FROM listings WHERE id = ?').get(Number(result.lastInsertRowid));
    return json(res, 201, { listing: listingResponse(row, user) });
  }

  const listingMatch = path.match(/^\/api\/listings\/(\d+)$/);
  if (listingMatch && ['PATCH', 'DELETE'].includes(req.method)) {
    if (!user) return json(res, 401, { error: 'Sign in to manage your posts.' });
    const id = Number(listingMatch[1]);
    const existing = db.prepare('SELECT * FROM listings WHERE id = ?').get(id);
    if (!existing) return json(res, 404, { error: 'This post could not be found.' });
    if (existing.user_id !== user.id) return json(res, 403, { error: 'You can only manage your own posts.' });
    if (req.method === 'DELETE') {
      db.prepare('DELETE FROM listings WHERE id = ? AND user_id = ?').run(id, user.id);
      return json(res, 200, { ok: true });
    }
    const body = await readBody(req);
    if (Object.hasOwn(body, 'status')) {
      if (!['open', 'resolved'].includes(body.status)) return json(res, 400, { error: 'Choose an available post status.' });
      db.prepare("UPDATE listings SET status = ?, updated_at = datetime('now') WHERE id = ? AND user_id = ?").run(body.status, id, user.id);
      const updated = db.prepare('SELECT * FROM listings WHERE id = ?').get(id);
      return json(res, 200, { listing: listingResponse(updated, user) });
    }
    const value = validateListing(body);
    db.prepare(`UPDATE listings SET kind = ?, title = ?, category = ?, description = ?, location = ?, item_date = ?, contact_email = ?, updated_at = datetime('now')
      WHERE id = ? AND user_id = ?`).run(value.kind, value.title, value.category, value.description, value.location, value.itemDate, value.contactEmail, id, user.id);
    const updated = db.prepare('SELECT * FROM listings WHERE id = ?').get(id);
    return json(res, 200, { listing: listingResponse(updated, user) });
  }

  return json(res, 404, { error: 'Not found.' });
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (url.pathname.startsWith('/api/')) {
      if (!['GET', 'POST', 'PATCH', 'DELETE'].includes(req.method)) return json(res, 405, { error: 'Method not allowed.' }, { Allow: 'GET, POST, PATCH, DELETE' });
      return await api(req, res, url);
    }
    const requested = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
    const safePath = normalize(requested).replace(/^([.][.][/\\])+/, '');
    const file = join(publicDir, safePath);
    if (!file.startsWith(publicDir) || !existsSync(file)) return json(res, 404, { error: 'Not found.' });
    res.writeHead(200, { 'Content-Type': mimeTypes[extname(file)] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin-when-cross-origin' });
    res.end(readFileSync(file));
  } catch (error) {
    if (!res.headersSent) json(res, error.status || 500, { error: error.status ? error.message : 'Something went wrong. Please try again.' });
    else res.end();
  }
});

const port = Number(process.env.PORT || 3000);
server.listen(port, '0.0.0.0', () => console.log(`Lost & Found is ready at http://localhost:${port}`));
