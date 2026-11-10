import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';
const MODE = process.env.MODE || 'mock'; // 'mock' for tests/local, 'live' for real WhatsApp link
const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const BRIDGE_PASSWORD = process.env.BRIDGE_PASSWORD || 'test-password';
const ALLOWED_CHAT_JID = process.env.ALLOWED_CHAT_JID || (MODE === 'mock' ? 'mock-chat@s.whatsapp.net' : '');
// Durations are configurable in hours at launch (SETUP_HOURS / SESSION_HOURS);
// the raw *_MS variables remain as overrides. Hours are validated and clamped:
// setup 0.25-12h, session 1-168h (a week), so a typo cannot pin the bridge open.
const HOUR = 60 * 60 * 1000;
function hoursToMs(v, defMs, min, max, name) {
  if (v === undefined || v === '') return defMs;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) { console.warn(`${name}="${v}" is not a positive number; using default ${defMs / HOUR}h`); return defMs; }
  const clamped = Math.min(Math.max(n, min), max);
  if (clamped !== n) console.warn(`${name}=${n}h is outside ${min}-${max}h; clamped to ${clamped}h`);
  return Math.round(clamped * HOUR);
}
const SETUP_WINDOW_MS = process.env.SETUP_WINDOW_MS
  ? Number(process.env.SETUP_WINDOW_MS)
  : hoursToMs(process.env.SETUP_HOURS, 2 * HOUR, 0.25, 12, 'SETUP_HOURS'); // default 2h to link
const ACCESS_WINDOW_MS = process.env.ACCESS_WINDOW_MS
  ? Number(process.env.ACCESS_WINDOW_MS)
  : hoursToMs(process.env.SESSION_HOURS, 24 * HOUR, 1, 168, 'SESSION_HOURS'); // default 24h of access
const WATCH_MS = Number(process.env.WATCH_MS || 15000);

fs.mkdirSync(DATA_DIR, { recursive: true });
const stateFile = path.join(DATA_DIR, 'state.json');
const msgFile = path.join(DATA_DIR, 'messages.json');

const loadJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const saveJson = (f, v) => fs.writeFileSync(f, JSON.stringify(v));

// createdAt/activatedAt persist across restarts: windows survive a reboot.
const state = loadJson(stateFile, null) || { createdAt: Date.now(), activatedAt: null };
saveJson(stateFile, state);
const messages = loadJson(msgFile, []);
let activatedAtMonoNs = null; // process-monotonic activation mark; null after restart (wall clock then governs)

const sessionToken = crypto.createHash('sha256').update(`bridge:${BRIDGE_PASSWORD}:${state.createdAt}`).digest('hex');

function elapsedAccessMs() {
  if (!state.activatedAt) return 0;
  const wall = Math.max(0, Date.now() - state.activatedAt); // fail closed under clock rollback via mono below
  const mono = activatedAtMonoNs != null ? Number(process.hrtime.bigint() - activatedAtMonoNs) / 1e6 : 0;
  return Math.max(wall, mono);
}
function status() {
  const now = Date.now();
  if (state.activatedAt) return elapsedAccessMs() > ACCESS_WINDOW_MS ? 'expired' : 'ok';
  if (now > state.createdAt + SETUP_WINDOW_MS) return 'setup-expired';
  return 'ok';
}
function markActivated() {
  if (!state.activatedAt) {
    state.activatedAt = Date.now();
    activatedAtMonoNs = process.hrtime.bigint();
    saveJson(stateFile, state);
  }
}

function send(res, code, body, headers = {}) {
  const isObj = typeof body === 'object' && body !== null;
  res.writeHead(code, { 'content-type': isObj ? 'application/json' : 'text/html; charset=utf-8', ...headers });
  res.end(isObj ? JSON.stringify(body) : body);
}
const authed = (req) => (req.headers.cookie || '').includes(`bridge_session=${sessionToken}`);
function badOrigin(req) {
  if (req.method !== 'POST') return false;
  const origin = req.headers.origin;
  if (!origin) return false;
  try { return new URL(origin).host !== req.headers.host; } catch { return true; }
}
function gate(req, res) {
  if (badOrigin(req)) { send(res, 403, { error: 'bad origin' }); return true; }
  if (status() !== 'ok') { send(res, 410, { error: status(), status: status() }); return true; }
  if (!authed(req)) { send(res, 401, { error: 'login required' }); return true; }
  return false;
}
const readBody = (req) => new Promise((resolve) => {
  let b = '';
  req.on('data', (c) => { b += c; if (b.length > 1e5) req.destroy(); });
  req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch { resolve({}); } });
});

// login rate limit: 5 attempts per 5 minutes per IP
const attempts = new Map();
function loginLimited(ip) {
  const now = Date.now();
  const a = attempts.get(ip);
  if (!a || now > a.resetAt) { attempts.set(ip, { count: 1, resetAt: now + 300000 }); return false; }
  a.count += 1;
  return a.count > 5;
}
const pwEqual = (a, b) => {
  const x = Buffer.from(String(a ?? '').slice(0, 256).padEnd(256));
  const y = Buffer.from(String(b ?? '').slice(0, 256).padEnd(256));
  return crypto.timingSafeEqual(x, y);
};

// --- WhatsApp adapter: 'mock' stores locally and echoes; 'live' uses Baileys. ---
let adapter;
if (MODE === 'live') {
  const { startLive } = await import('./live.js');
  adapter = await startLive({
    state, saveState: () => saveJson(stateFile, state),
    messages, saveMessages: () => saveJson(msgFile, messages),
    allowedJid: ALLOWED_CHAT_JID, dataDir: DATA_DIR, markActivated,
    pairingPhone: process.env.PAIRING_PHONE || '',
  });
} else {
  let mockLink = 'mock';
  adapter = {
    mockShutdown: false,
    async send(text) {
      messages.push({ from: 'me', text, ts: Date.now() });
      saveJson(msgFile, messages);
      setTimeout(() => {
        if (status() === 'ok') {
          messages.push({ from: 'them', text: `Mock reply: ${text}`, ts: Date.now() });
          saveJson(msgFile, messages);
        }
      }, 300);
    },
    async activate() { markActivated(); },
    async receive(jid, text) { // scope filter, same rule as live adapter
      if (jid !== ALLOWED_CHAT_JID) return false;
      messages.push({ from: 'them', text, ts: Date.now() });
      saveJson(msgFile, messages);
      return true;
    },
    async qrDataUrl() { return null; },
    pairingCode() { return null; },
    linkState() { return mockLink; },
    async shutdown() { this.mockShutdown = true; mockLink = 'closed'; },
  };
}

// expiry watcher: once the window closes, shut the WhatsApp session down (fail closed)
let shutDownInitiated = false;
const watcher = setInterval(async () => {
  if (status() === 'ok' || shutDownInitiated) return;
  shutDownInitiated = true;
  try { await adapter.shutdown?.(); } catch {}
}, WATCH_MS);
watcher.unref();

const PAGE = fs.readFileSync(new URL('./public/index.html', import.meta.url), 'utf8');

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/ping') {
    return send(res, 200, {
      status: status(), now: Date.now(), connection: adapter.linkState?.() || 'unknown',
      activatedAt: state.activatedAt,
      deadline: state.activatedAt ? state.activatedAt + ACCESS_WINDOW_MS : null,
      setupDeadline: state.createdAt + SETUP_WINDOW_MS,
    });
  }
  if (url.pathname === '/') return send(res, 200, PAGE);
  if (url.pathname === '/api/login' && req.method === 'POST') {
    const ip = req.socket.remoteAddress || 'x';
    if (loginLimited(ip)) return send(res, 429, { error: 'too many attempts' });
    const body = await readBody(req);
    if (pwEqual(body.password, BRIDGE_PASSWORD)) {
      // Secure only when the request arrived over HTTPS (direct TLS or the tunnel's
      // X-Forwarded-Proto): production is always HTTPS, while the local mock demo
      // on loopback keeps working in every browser.
      const secure = req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https';
      return send(res, 200, { ok: true }, { 'set-cookie': `bridge_session=${sessionToken}; HttpOnly;${secure ? ' Secure;' : ''} SameSite=Strict; Path=/` });
    }
    return send(res, 401, { error: 'wrong password' });
  }
  if (url.pathname === '/api/messages' && req.method === 'GET') {
    if (gate(req, res)) return;
    return send(res, 200, { status: status(), connection: adapter.linkState?.() || 'unknown', messages, deadline: state.activatedAt ? state.activatedAt + ACCESS_WINDOW_MS : null });
  }
  if (url.pathname === '/api/send' && req.method === 'POST') {
    if (gate(req, res)) return;
    const body = await readBody(req);
    await adapter.send(String(body.text || '').slice(0, 4000));
    return send(res, 200, { ok: true });
  }
  if (url.pathname === '/api/qr' && req.method === 'GET') {
    if (gate(req, res)) return;
    return send(res, 200, { linked: !!state.activatedAt, qr: await adapter.qrDataUrl(), code: adapter.pairingCode ? adapter.pairingCode() : null });
  }
  if (MODE === 'mock' && url.pathname === '/api/mock-activate' && req.method === 'POST') {
    if (gate(req, res)) return;
    await adapter.activate();
    return send(res, 200, { ok: true, activatedAt: state.activatedAt });
  }
  if (MODE === 'mock' && url.pathname === '/api/mock-inbound' && req.method === 'POST') {
    if (gate(req, res)) return;
    const body = await readBody(req);
    const stored = await adapter.receive(String(body.jid || ''), String(body.text || ''));
    return send(res, 200, { stored });
  }
  if (MODE === 'mock' && url.pathname === '/api/mock-state' && req.method === 'GET') {
    return send(res, 200, { shutdownCalled: !!adapter.mockShutdown, connection: adapter.linkState() });
  }
  send(res, 404, { error: 'not found' });
});

server.listen(PORT, HOST, () => {
  console.log(`wa-bridge (${MODE}) listening on http://${HOST}:${PORT} status=${status()}`);
});
