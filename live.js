import fs from 'node:fs';
import path from 'node:path';
import makeWASocket, { useMultiFileAuthState, DisconnectReason } from '@whiskeysockets/baileys';
import QRCode from 'qrcode';

// Live WhatsApp adapter (Baileys). Links once via QR (WhatsApp > Linked devices).
// Only the allowed chat JID is ever read from or sent to; everything else is dropped.
export async function startLive({ state, saveState, messages, saveMessages, allowedJid, dataDir, markActivated, pairingPhone }) {
  if (!allowedJid) throw new Error('ALLOWED_CHAT_JID is required in live mode');
  const authDir = path.join(dataDir, 'auth');
  let { state: authState, saveCreds } = await useMultiFileAuthState(authDir);

  // Scope: accept the chat under any addressing form (classic JID or LID).
  // Resolve the real forms via onWhatsApp once the link opens.
  const number = allowedJid.replace(/@.*$/, '');
  const allowedJids = new Set([allowedJid, `${number}@s.whatsapp.net`]);
  let sendJid = allowedJid;
  async function resolveChat() {
    try {
      const res = await sock.onWhatsApp(number);
      for (const r of res || []) {
        if (!r) continue;
        if (r.jid) { allowedJids.add(r.jid); if (r.exists !== false) sendJid = r.jid; }
        if (r.lid) {
          const lid = typeof r.lid === 'string' ? r.lid : String(r.lid);
          allowedJids.add(lid.includes('@') ? lid : `${lid}@lid`);
        }
      }
    } catch {}
  }
  let currentQr = null;
  let currentPairingCode = null;
  let sock = null;
  let linkState = 'connecting';
  let down = false;
  let backoff = 1000;

  const connect = () => {
    sock = makeWASocket({ auth: authState });
    let pairRequested = false;
    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', (u) => {
      if (u.qr) {
        currentQr = u.qr;
        if (pairingPhone && !pairRequested) {
          pairRequested = true;
          sock.requestPairingCode(pairingPhone)
            .then((code) => { currentPairingCode = code; console.log('PAIRING-CODE: ' + code); })
            .catch((e) => console.log('PAIRING-CODE-ERROR: ' + ((e && e.message) || e)));
        }
      }
      if (u.connection === 'open') {
        currentQr = null;
        currentPairingCode = null;
        linkState = 'open';
        backoff = 1000;
        resolveChat(); // learn the chat's real JID/LID forms
        markActivated(); // the 24h clock starts at link
      }
      if (u.connection === 'close') {
        linkState = 'closed';
        currentPairingCode = null;
        const code = u.lastDisconnect?.error?.output?.statusCode;
        if (code === DisconnectReason.loggedOut) {
          // Session revoked (device unlinked or logged out elsewhere): reset auth
          // so the reconnect emits a fresh QR instead of dead-ending the bridge.
          try { fs.rmSync(authDir, { recursive: true, force: true }); } catch {}
          setTimeout(async () => {
            if (down) return;
            try {
              ({ state: authState, saveCreds } = await useMultiFileAuthState(authDir));
              connect();
            } catch {}
          }, 2000);
          return;
        }
        if (!down) setTimeout(connect, backoff), backoff = Math.min(backoff * 2, 30000);
      }
    });
    sock.ev.on('messages.upsert', ({ messages: msgs }) => {
      for (const m of msgs || []) {
        const jid = m.key?.remoteJid;
        const alt = m.key?.remoteJidAlt;
        if (!allowedJids.has(jid) && !(alt && allowedJids.has(alt))) continue; // scope: only the allowed chat
        const text = m.message?.conversation || m.message?.extendedTextMessage?.text || '';
        if (!text) continue;
        messages.push({ from: m.key.fromMe ? 'me' : 'them', text, ts: (Number(m.messageTimestamp) || 0) * 1000 || Date.now() });
      }
      saveMessages();
    });
  };
  connect();

  return {
    async send(text) { await sock.sendMessage(sendJid, { text }); },
    async qrDataUrl() { return currentQr ? QRCode.toDataURL(currentQr) : null; },
    pairingCode() { return currentPairingCode; },
    linkState() { return linkState; },
    async shutdown() {
      down = true;
      try { await sock.logout(); } catch {}
      try { sock.end(undefined); } catch {}
      linkState = 'closed';
    },
  };
}
