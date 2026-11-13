// Live-adapter pairing tests with a fake WhatsApp socket (no network).
// Run: node test/live-tests.js
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { startLive } from '../live.js';

let passed = 0, failed = 0;
const ok = (name, cond) => { if (cond) { passed++; console.log(`ok - ${name}`); } else { failed++; console.log(`FAIL - ${name}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fakeSocket() {
  const handlers = {};
  const s = {
    handlers,
    pairCalls: 0,
    pairResult: 'FAKECODE',
    pairDelay: 0,
    pairError: null,
    ev: { on: (ev, fn) => { handlers[ev] = fn; } },
    async requestPairingCode() {
      s.pairCalls++;
      if (s.pairError) throw s.pairError;
      if (s.pairDelay) await sleep(s.pairDelay);
      return s.pairResult;
    },
    async onWhatsApp() { return []; },
    async sendMessage() {},
    async logout() {},
    end() {},
  };
  return s;
}

async function makeAdapter(socketOpts = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wab-live-'));
  const sockets = [];
  const makeSocket = () => { const s = fakeSocket(); Object.assign(s, socketOpts); sockets.push(s); return s; };
  const adapter = await startLive({
    state: {}, saveState: () => {}, messages: [], saveMessages: () => {},
    allowedJid: '16508702892@s.whatsapp.net', dataDir, markActivated: () => {}, pairingPhone: '919677854216',
    makeSocket,
  });
  return { adapter, sockets, dataDir };
}

// 1. a QR event must NOT auto-request a pairing code (that hammered WhatsApp's rate limit)
{
  const { adapter, sockets } = await makeAdapter();
  sockets[0].handlers['connection.update']({ qr: 'qr-payload' });
  await sleep(50);
  ok('qr event does not auto-request a pairing code', sockets[0].pairCalls === 0);
  ok('qr stored for display', (await adapter.qrDataUrl()) !== null);
}

// 2. on-demand request stores code + timestamp; display clears on close
{
  const { adapter, sockets } = await makeAdapter();
  const code = await adapter.requestPairingCode();
  ok('on-demand request returns the code', code === 'FAKECODE');
  ok('code stored for display', adapter.pairingCode() === 'FAKECODE');
  ok('generation timestamp recorded', adapter.pairingCodeAt() > 0);
  sockets[0].handlers['connection.update']({ connection: 'close', lastDisconnect: { error: { output: { statusCode: 500 } } } });
  ok('code cleared on disconnect', adapter.pairingCode() === null);
  ok('timestamp cleared on disconnect', adapter.pairingCodeAt() === 0);
  await adapter.shutdown();
}

// 3. 60s guard rejects a rapid second request
{
  const { adapter } = await makeAdapter();
  await adapter.requestPairingCode();
  let err = null;
  try { await adapter.requestPairingCode(); } catch (e) { err = e; }
  ok('rapid second request rejected', !!err && err.retryAfter > 0);
  await adapter.shutdown();
}

// 4. upstream failure propagates and stores nothing
{
  const { adapter, sockets } = await makeAdapter({ pairError: new Error('upstream said no') });
  let err = null;
  try { await adapter.requestPairingCode(); } catch (e) { err = e; }
  ok('upstream failure propagates', !!err);
  ok('no code stored after failure', adapter.pairingCode() === null);
  await adapter.shutdown();
}

// 5a. a request resolving after close but BEFORE the replacement socket exists is also dead
{
  const { adapter, sockets } = await makeAdapter({ pairDelay: 300 });
  const pending = adapter.requestPairingCode();
  await sleep(50);
  sockets[0].handlers['connection.update']({ connection: 'close', lastDisconnect: { error: { output: { statusCode: 500 } } } });
  let err = null;
  try { await pending; } catch (e) { err = e; } // resolves at ~t+300, reconnect only at ~t+1000
  ok('close-before-replacement result rejected', !!err);
  ok('no dead code stored pre-replacement', adapter.pairingCode() === null);
  await adapter.shutdown();
}

// 5b. requests are refused while down or between connections
{
  const { adapter, sockets } = await makeAdapter();
  sockets[0].handlers['connection.update']({ connection: 'close', lastDisconnect: { error: { output: { statusCode: 500 } } } });
  let err = null;
  try { await adapter.requestPairingCode(); } catch (e) { err = e; }
  ok('request refused while closed between connections', !!err && !err.retryAfter);
  await adapter.shutdown();
  let err2 = null;
  try { await adapter.requestPairingCode(); } catch (e) { err2 = e; }
  ok('request refused after shutdown', !!err2);
}

// 5c. in-flight request resolving after socket replacement must not store a dead code
{
  const { adapter, sockets } = await makeAdapter({ pairDelay: 1200 });
  const pending = adapter.requestPairingCode(); // resolves at ~t+1200 on socket 1
  await sleep(50);
  // socket resets (backoff starts at 1s) and is replaced before the request resolves
  sockets[0].handlers['connection.update']({ connection: 'close', lastDisconnect: { error: { output: { statusCode: 500 } } } });
  let err = null;
  try { await pending; } catch (e) { err = e; }
  ok('stale in-flight result rejected', !!err);
  ok('dead code not stored', adapter.pairingCode() === null);
  await sleep(1400); // backoff reconnect fires (~1s)
  ok('reconnect created a replacement socket', sockets.length === 2);
  // the 60s guard still covers the first request; the in-process test override shortens it
  const code = await adapter.requestPairingCode({ minIntervalMs: 1000 });
  ok('fresh request works on the new socket', code === 'FAKECODE' && adapter.pairingCode() === 'FAKECODE' && sockets[1].pairCalls === 1);
  await adapter.shutdown();
}

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
