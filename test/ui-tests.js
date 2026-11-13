// UI flow tests for the link page (headless Chrome via puppeteer-core).
// Skips cleanly when no Chrome binary is present. Run: node test/ui-tests.js
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import puppeteer from 'puppeteer-core';

let passed = 0, failed = 0, skipped = 0;
const ok = (name, cond) => { if (cond) { passed++; console.log(`ok - ${name}`); } else { failed++; console.log(`FAIL - ${name}`); } };
const skip = (name, why) => { skipped++; console.log(`skip - ${name} (${why})`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CHROME = ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser']
  .find((p) => { try { fs.accessSync(p); return true; } catch { return false; } });

let port = 3520;
function startMock(env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wab-ui-'));
  const child = spawn(process.execPath, [new URL('../server.js', import.meta.url).pathname], {
    env: { ...process.env, PORT: String(port), MODE: 'mock', BRIDGE_PASSWORD: 'test-password', DATA_DIR: dir, ...env },
    stdio: 'ignore',
  });
  const base = `http://127.0.0.1:${port}`;
  port += 1;
  return { child, base };
}
const up = async (base) => {
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch(`${base}/ping`); if (r.ok) return; } catch {}
    await sleep(100);
  }
  throw new Error('server did not start');
};
const pairReqs = async (base) => (await (await fetch(`${base}/api/mock-state`)).json()).pairReqs;

if (!CHROME) {
  skip('all UI tests', 'no Chrome/Chromium binary found');
} else {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] });
  try {
    // A. visible tab: code appears automatically (no click), auto-regenerates after expiry
    {
      const { child, base } = startMock({ MOCK_PAIR_MIN_MS: '0', MOCK_PAIR_TTL_MS: '2500' });
      await up(base);
      const page = await browser.newPage();
      await page.setViewport({ width: 390, height: 844 });
      await page.evaluateOnNewDocument(() => { window.__PAIR_AUTO_MIN_MS = 400; });
      await page.goto(base + '/', { waitUntil: 'networkidle0' });
      await page.type('#pw', 'test-password');
      await page.click('#login button.primary');
      await page.waitForFunction(() => document.getElementById('paircode').textContent.trim().length > 0, { timeout: 10000 });
      ok('code appears automatically without clicking', (await pairReqs(base)) >= 1);
      const first = await page.$eval('#paircode', (e) => e.textContent.trim());
      const note = await page.$eval('#codenote', (e) => e.textContent);
      ok('age note shown with the code', /Generated \d+s ago/.test(note));
      await page.waitForFunction((f) => document.getElementById('paircode').textContent.trim() !== f && document.getElementById('paircode').textContent.trim().length > 0, { timeout: 15000 }, first);
      ok('code auto-regenerates while the tab is watched', (await pairReqs(base)) >= 2);

      // B. hidden tab: no background code requests
      const before = await pairReqs(base);
      const beforeCode = await page.$eval('#paircode', (e) => e.textContent.trim());
      const other = await browser.newPage();
      await other.goto('about:blank');
      await other.bringToFront();
      await sleep(2000); // several client cadences, shorter than the 20s hidden poll
      const during = await pairReqs(base);
      await other.close();
      ok('no code requests while the tab is hidden', during === before);

      await page.bringToFront();
      // the pre-hide code may still be on screen; wait for a DIFFERENT code so we know a fresh request landed
      await page.waitForFunction((old) => {
        const c = document.getElementById('paircode').textContent.trim();
        return c.length > 0 && c !== old;
      }, { timeout: 10000 }, beforeCode);
      ok('auto-request resumes when the tab is visible again', (await pairReqs(base)) > during);

      // C. linking clears the pairing UI
      await page.evaluate(() => fetch('/api/mock-activate', { method: 'POST' }));
      await page.waitForFunction(() => document.getElementById('qr').style.display === 'none' && document.getElementById('chat').style.display === 'flex', { timeout: 10000 });
      ok('pairing UI clears once linked', true);
      await page.close();
      child.kill();
    }

    // D. server-side 60s guard surfaces a wait note on rapid manual taps
    {
      const { child, base } = startMock(); // default guard 60s, code persists
      await up(base);
      const page = await browser.newPage();
      await page.goto(base + '/', { waitUntil: 'networkidle0' });
      await page.type('#pw', 'test-password');
      await page.click('#login button.primary');
      await page.waitForFunction(() => document.getElementById('paircode').textContent.trim().length > 0, { timeout: 10000 });
      await page.click('#getcode');
      await page.waitForFunction(() => /One code per minute/.test(document.getElementById('codenote').textContent), { timeout: 10000 });
      ok('rapid manual tap shows the wait note (429 handled)', true);
      await page.close();
      child.kill();
    }
  } finally {
    await browser.close();
  }
}

console.log(`${passed} passed, ${failed} failed, ${skipped} skipped`);
process.exit(failed ? 1 : 0);
