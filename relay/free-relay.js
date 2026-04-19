const http = require('http');

const PORT = Number.parseInt(process.env.PORT || '8787', 10);
const MAX_TEXT = 180;
const MAX_ID = 64;
const MAX_NAME = 24;
const MAX_INBOX = 100;
const MESSAGE_TTL_MS = 1000 * 60 * 60 * 24;
const inboxes = new Map();

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'content-type',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > 16 * 1024) {
        reject(new Error('Request body is too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function clean(value, max) {
  return String(value ?? '')
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function cleanId(value) {
  return clean(value, MAX_ID).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, MAX_ID);
}

function cleanAppearance(value = {}) {
  return {
    selectedRibbon: clean(value.selectedRibbon, 18) || null,
    selectedSkin: clean(value.selectedSkin, 40) || null,
  };
}

function cleanMessage(raw = {}) {
  const from = raw.from || {};
  return {
    id: cleanId(raw.id) || `msg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    to: cleanId(raw.to),
    text: clean(raw.text, MAX_TEXT),
    sentAt: clean(raw.sentAt, 40) || new Date().toISOString(),
    from: {
      id: cleanId(from.id || from.userId),
      catName: clean(from.catName || 'Mochi', MAX_NAME) || 'Mochi',
      appearance: cleanAppearance(from.appearance),
    },
  };
}

function pruneInbox(messages) {
  const cutoff = Date.now() - MESSAGE_TTL_MS;
  return messages
    .filter((message) => Date.parse(message.sentAt) >= cutoff)
    .slice(-MAX_INBOX);
}

function storeMessage(message) {
  const current = inboxes.get(message.to) || [];
  current.push(message);
  inboxes.set(message.to, pruneInbox(current));
}

function readInbox(to, since) {
  const current = pruneInbox(inboxes.get(to) || []);
  inboxes.set(to, current);
  if (!since) return current;
  const sinceNumber = Number.parseInt(since, 10);
  if (Number.isFinite(sinceNumber)) {
    return current.filter((message) => Date.parse(message.sentAt) >= sinceNumber);
  }
  return current.filter((message) => message.id > since);
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    sendJson(res, 204, {});
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (url.pathname === '/health') {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (url.pathname !== '/messages') {
    sendJson(res, 404, { ok: false, error: 'Not found' });
    return;
  }

  if (req.method === 'GET') {
    const to = cleanId(url.searchParams.get('to'));
    if (!to) {
      sendJson(res, 400, { ok: false, error: 'Missing to' });
      return;
    }
    sendJson(res, 200, { ok: true, messages: readInbox(to, url.searchParams.get('since')) });
    return;
  }

  if (req.method === 'POST') {
    try {
      const raw = JSON.parse(await readBody(req));
      const message = cleanMessage(raw);
      if (!message.to || !message.text || !message.from.id) {
        sendJson(res, 400, { ok: false, error: 'Invalid message' });
        return;
      }
      storeMessage(message);
      sendJson(res, 200, { ok: true, id: message.id });
    } catch (error) {
      sendJson(res, 400, { ok: false, error: error.message || 'Bad request' });
    }
    return;
  }

  sendJson(res, 405, { ok: false, error: 'Method not allowed' });
});

server.listen(PORT, () => {
  console.log(`Sleepy Pet relay listening on http://localhost:${PORT}`);
});
