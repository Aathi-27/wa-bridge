// Bridge behavior tests (mock mode). Run: node test/run-tests.js
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

let passed = 0, failed = 0;
const ok = (name, cond) => { if (cond) { passed++; console.log(`ok - ${name}`); } else { failed++; console.log(`FAIL - ${name}`); } };
let port = 3460;

function startServer(env = {}, dataDir) {
  const dir = dataDir || fs.mkdtempSync(path.join(os.tmpdir(), 'wab-'));
  const child = spawn(process.execPath, [new URL('../server.js', import.meta.url).pathname], {
    env: { ...process.env, PORT: String(port), MODE: 'mock', BRIDGE_PASSWORD: 'test-password', WATCH_MS: '200', DATA_DIR: dir, ...env },
    stdio: 'ignore',
  });
  const base = `http://127.0.0.1:${port}`;
  port += 1;
  return { child, dir, base };
}
const up = async (base) => {
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch(`${base}/ping`); if (r.ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not start');
};
const login = async (base) => {
  const r = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'test-password' }) });
  return r.headers.get('set-cookie').split(';')[0];
};

// 1. auth gate, login, send/echo, scope filter, restart persistence
{
  const { child, dir, base } = startServer();
  await up(base);
  let r = await fetch(`${base}/api/messages`);
  ok('messages requires login (401)', r.status === 401);
  r = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'nope' }) });
  ok('wrong password rejected (401)', r.status === 401);
  const cookie = await login(base);
  r = await fetch(`${base}/api/messages`, { headers: { cookie } });
  ok('login grants access (200)', r.status === 200);
  r = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-proto': 'https' }, body: JSON.stringify({ password: 'test-password' }) });
  ok('cookie is Secure over HTTPS', (r.headers.get('set-cookie') || '').includes('Secure'));
  r = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'test-password' }) });
  ok('cookie stays non-Secure on local HTTP (demo works)', !(r.headers.get('set-cookie') || '').includes('Secure'));

  await fetch(`${base}/api/mock-activate`, { method: 'POST', headers: { cookie } });
  r = await fetch(`${base}/api/send`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ text: 'hello' }) });
  ok('send accepted (200)', r.status === 200);
  await new Promise((r) => setTimeout(r, 500));
  let data = await (await fetch(`${base}/api/messages`, { headers: { cookie } })).json();
  ok('echo reply arrived', data.messages.some((m) => m.from === 'them' && m.text.includes('Mock reply')));

  await fetch(`${base}/api/mock-inbound`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ jid: 'stranger@s.whatsapp.net', text: 'spam' }) });
  await fetch(`${base}/api/mock-inbound`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ jid: 'mock-chat@s.whatsapp.net', text: 'real' }) });
  data = await (await fetch(`${base}/api/messages`, { headers: { cookie } })).json();
  ok('foreign chat dropped', !data.messages.some((m) => m.text === 'spam'));
  ok('allowed chat stored', data.messages.some((m) => m.text === 'real'));
  ok('deadline set after activation', typeof data.deadline === 'number');

  const before = data.deadline;
  child.kill();
  await new Promise((r) => setTimeout(r, 400));
  const again = startServer({}, dir);
  await up(again.base);
  r = await fetch(`${again.base}/api/messages`, { headers: { cookie: await login(again.base) } });
  data = await r.json();
  ok('deadline survives restart', data.deadline === before);
  again.child.kill();
}

// 2. 24h expiry: 410, ping reports expired, watcher shuts the adapter down
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wab-'));
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ createdAt: Date.now() - 26 * 3600e3, activatedAt: Date.now() - 25 * 3600e3 }));
  const { child, base } = startServer({}, dir);
  await up(base);
  let r = await fetch(`${base}/api/messages`, { headers: { cookie: await login(base) } });
  ok('access expired after 24h (410)', r.status === 410);
  const ping = await (await fetch(`${base}/ping`)).json();
  ok('ping reports expired, still responds (200)', ping.status === 'expired');
  await new Promise((r) => setTimeout(r, 600));
  const ms = await (await fetch(`${base}/api/mock-state`)).json();
  ok('expiry watcher shut the session down', ms.shutdownCalled === true && ms.connection === 'closed');
  child.kill();
}

// 3. setup window expiry without activation
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wab-'));
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ createdAt: Date.now() - 3 * 3600e3, activatedAt: null }));
  const { child, base } = startServer({}, dir);
  await up(base);
  const r = await fetch(`${base}/api/messages`, { headers: { cookie: await login(base) } });
  ok('setup window lapse blocks access (410)', r.status === 410);
  const ping = await (await fetch(`${base}/ping`)).json();
  ok('ping reports setup-expired', ping.status === 'setup-expired');
  child.kill();
}

// 4. login rate limit and origin check
{
  const { child, base } = startServer();
  await up(base);
  for (let i = 0; i < 6; i++) {
    await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'bad' }) });
  }
  const r = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'bad' }) });
  ok('login rate limited after 5 attempts (429)', r.status === 429);
  const r2 = await fetch(`${base}/api/send`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.example' }, body: '{}' });
  ok('cross-origin POST rejected (403)', r2.status === 403);
  child.kill();
}

// 5. configurable durations: hours env, validation fallback, clamping
{
  const { child, base } = startServer({ SETUP_HOURS: '3', SESSION_HOURS: '10' });
  await up(base);
  let ping = await (await fetch(`${base}/ping`)).json();
  ok('SETUP_HOURS=3 sets a 3h setup window', Math.abs((ping.setupDeadline - ping.now) - 3 * 3600e3) < 60000);
  const cookie = await login(base);
  await fetch(`${base}/api/mock-activate`, { method: 'POST', headers: { cookie } });
  let data = await (await fetch(`${base}/api/messages`, { headers: { cookie } })).json();
  ping = await (await fetch(`${base}/ping`)).json();
  ok('SESSION_HOURS=10 sets a 10h access window', Math.abs((data.deadline - ping.activatedAt) - 10 * 3600e3) < 1000);
  child.kill();

  const bad = startServer({ SETUP_HOURS: 'abc', SESSION_HOURS: '9999' });
  await up(bad.base);
  ping = await (await fetch(`${bad.base}/ping`)).json();
  ok('invalid SETUP_HOURS falls back to 2h', Math.abs((ping.setupDeadline - ping.now) - 2 * 3600e3) < 60000);
  const cookie2 = await login(bad.base);
  await fetch(`${bad.base}/api/mock-activate`, { method: 'POST', headers: { cookie: cookie2 } });
  data = await (await fetch(`${bad.base}/api/messages`, { headers: { cookie: cookie2 } })).json();
  ping = await (await fetch(`${bad.base}/ping`)).json();
  ok('SESSION_HOURS=9999 clamps to 168h', Math.abs((data.deadline - ping.activatedAt) - 168 * 3600e3) < 1000);
  bad.child.kill();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
