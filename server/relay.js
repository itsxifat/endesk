'use strict';

// ===========================================================================
// EnDesk signaling relay.
//
// A tiny WebSocket broker that lets two EnDesk apps find each other by device
// ID and negotiate a direct peer-to-peer WebRTC connection. It only relays
// signaling (SDP/ICE) and the accept/reject handshake — it never sees the
// screen video, the input, or the password (the password is verified by the
// host app, not here).
//
// Run anywhere both devices can reach:   PORT=8080 node relay.js
// Behind TLS (recommended for the internet) terminate wss:// with a reverse
// proxy (nginx/caddy) in front of this process.
//
// Optional environment:
//   OWNERS_FILE  where device-ID ownership is persisted (default: in memory only)
//   TURN_SECRET  coturn "static-auth-secret"; enables TURN fallback for sessions
//   TURN_URLS    comma-separated TURN URLs, e.g. turn:relay.example.com:3478
//   TURN_TTL     lifetime of minted TURN credentials in seconds (default 12h)
// ===========================================================================

const http = require('http');
const fs = require('fs');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = parseInt(process.env.PORT || '8080', 10);
const HOST = process.env.HOST || '0.0.0.0';
const OWNERS_FILE = process.env.OWNERS_FILE || '';
const TURN_SECRET = process.env.TURN_SECRET || '';
const TURN_URLS = (process.env.TURN_URLS || '').split(',').map((s) => s.trim()).filter(Boolean);
const TURN_TTL = parseInt(process.env.TURN_TTL || '43200', 10);

// A host may receive at most this many join requests per minute, which keeps
// guessing a session/unattended password impractically slow.
const JOINS_PER_MINUTE = 20;
// A single client address may claim at most this many new device IDs per hour.
const CLAIMS_PER_HOUR = 10;

const hosts = new Map(); // deviceId -> ws (a reachable host)
const pending = new Map(); // rid -> { viewer, host }

// ---------------------------------------------------------------------------
// Device-ID ownership. The first device to register an ID proves ownership with
// a secret key it keeps; later registrations of that ID must present the same
// key. Without this, anyone could claim another device's ID and receive the
// passwords viewers type for it.
// ---------------------------------------------------------------------------
const owners = new Map(); // deviceId -> sha256(device key)

function loadOwners() {
  if (!OWNERS_FILE) return;
  try {
    const data = JSON.parse(fs.readFileSync(OWNERS_FILE, 'utf8'));
    for (const [id, digest] of Object.entries(data)) owners.set(id, digest);
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('[relay] could not read owners file:', err.message);
  }
}

let saveTimer = null;
function saveOwners() {
  if (!OWNERS_FILE || saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const tmp = OWNERS_FILE + '.tmp';
    try {
      fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(owners)));
      fs.renameSync(tmp, OWNERS_FILE);
    } catch (err) {
      console.error('[relay] could not write owners file:', err.message);
    }
  }, 1000);
}

loadOwners();

// Fixed-window counters: key -> { count, resetAt }.
function overLimit(buckets, key, limit, windowMs) {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || now >= b.resetAt) {
    b = { count: 0, resetAt: now + windowMs };
    buckets.set(key, b);
  }
  b.count += 1;
  return b.count > limit;
}
const joinBuckets = new Map();
const claimBuckets = new Map();
setInterval(() => {
  const now = Date.now();
  for (const buckets of [joinBuckets, claimBuckets]) {
    for (const [k, b] of buckets) if (now >= b.resetAt) buckets.delete(k);
  }
}, 60000).unref();

// Short-lived TURN credentials (coturn "use-auth-secret" / TURN REST API).
function turnServers() {
  if (!TURN_SECRET || !TURN_URLS.length) return [];
  const username = `${Math.floor(Date.now() / 1000) + TURN_TTL}:endesk`;
  const credential = crypto.createHmac('sha1', TURN_SECRET).update(username).digest('base64');
  return [{ urls: TURN_URLS, username, credential }];
}

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, hosts: hosts.size, pending: pending.size, turn: TURN_URLS.length > 0 && !!TURN_SECRET }));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('EnDesk relay is running. Connect an EnDesk client to ws(s)://<this-host>:' + PORT);
});

// Signaling messages are a few KB of SDP at most.
const wss = new WebSocketServer({ server, maxPayload: 64 * 1024 });

// Behind a reverse proxy on loopback, trust its X-Real-IP; otherwise use the socket address.
function clientAddress(req) {
  const remote = req.socket.remoteAddress || '';
  const loopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
  return (loopback && req.headers['x-real-ip']) || remote;
}

function send(ws, obj) {
  if (ws && ws.readyState === ws.OPEN) {
    try {
      ws.send(JSON.stringify(obj));
    } catch {
      /* ignore */
    }
  }
}

function unlinkPeers(ws, notify) {
  const peer = ws._peer;
  if (peer) {
    peer._peer = null;
    ws._peer = null;
    if (notify) send(peer, { type: 'peer-left' });
  }
}

function dropPendingFor(ws) {
  for (const [rid, p] of pending) {
    if (p.viewer === ws || p.host === ws) {
      if (p.viewer === ws && p.host !== ws) send(p.host, { type: 'join-cancelled', rid });
      if (p.host === ws && p.viewer !== ws) send(p.viewer, { type: 'rejected', reason: 'host-unavailable' });
      pending.delete(rid);
    }
  }
}

wss.on('connection', (ws, req) => {
  ws._addr = clientAddress(req);
  ws._alive = true;
  ws.on('pong', () => {
    ws._alive = true;
  });

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (!msg || typeof msg.type !== 'string') return;

    switch (msg.type) {
      // ---- Register as a host reachable by ID ----
      case 'host': {
        const id = String(msg.id || '');
        const key = String(msg.key || '');
        if (!/^\d{9}$/.test(id) || key.length < 32) {
          send(ws, { type: 'error', code: 'bad-host', message: 'Invalid device registration.' });
          return;
        }
        // One device ID per connection.
        if (ws._hostId && ws._hostId !== id) return;
        const digest = crypto.createHash('sha256').update(key).digest('hex');
        const owner = owners.get(id);
        if (owner && owner !== digest) {
          send(ws, { type: 'error', code: 'id-taken', message: 'This device ID belongs to another device.' });
          return;
        }
        if (!owner) {
          if (overLimit(claimBuckets, ws._addr, CLAIMS_PER_HOUR, 3600000)) {
            send(ws, { type: 'error', code: 'rate-limited', message: 'Too many new devices from this network. Try again later.' });
            return;
          }
          owners.set(id, digest);
          saveOwners();
        }
        // If another socket held this id, release it (reconnection / restart).
        const prev = hosts.get(id);
        if (prev && prev !== ws) {
          prev._hostId = null;
        }
        ws._hostId = id;
        hosts.set(id, ws);
        send(ws, { type: 'host-ok', id });
        break;
      }

      // ---- Viewer requests to connect to a host ----
      case 'join': {
        const id = String(msg.id || '');
        const hostWs = hosts.get(id);
        if (!hostWs || hostWs.readyState !== hostWs.OPEN) {
          send(ws, { type: 'error', code: 'not-found', message: 'No device online with that ID.' });
          return;
        }
        if (hostWs._peer) {
          send(ws, { type: 'error', code: 'busy', message: 'That device is already in a session.' });
          return;
        }
        if (hostWs === ws) {
          send(ws, { type: 'error', code: 'self', message: 'Cannot connect to yourself.' });
          return;
        }
        if (overLimit(joinBuckets, id, JOINS_PER_MINUTE, 60000)) {
          send(ws, { type: 'error', code: 'rate-limited', message: 'Too many connection attempts to that device. Wait a minute and try again.' });
          return;
        }
        const rid = crypto.randomUUID();
        pending.set(rid, { viewer: ws, host: hostWs });
        // Forward the password to the host for verification (relay never checks it).
        send(hostWs, { type: 'join-request', rid, password: String(msg.password || '') });
        send(ws, { type: 'join-pending' });
        break;
      }

      // ---- Host accepts / rejects ----
      case 'join-decision': {
        const p = pending.get(msg.rid);
        if (!p || p.host !== ws) return;
        pending.delete(msg.rid);
        if (!p.viewer || p.viewer.readyState !== p.viewer.OPEN) return;

        if (msg.accept) {
          // Link the two sockets as peers.
          ws._peer = p.viewer;
          p.viewer._peer = ws;
          const iceServers = turnServers();
          send(ws, { type: 'session-begin', role: 'host', iceServers });
          send(p.viewer, { type: 'session-begin', role: 'viewer', iceServers });
        } else {
          send(p.viewer, { type: 'rejected', reason: String(msg.reason || 'declined') });
        }
        break;
      }

      // ---- Relay WebRTC signaling to the peer ----
      case 'signal': {
        if (ws._peer) send(ws._peer, { type: 'signal', data: msg.data });
        break;
      }

      // ---- End the current session ----
      case 'bye': {
        unlinkPeers(ws, true);
        dropPendingFor(ws);
        break;
      }

      default:
        break;
    }
  });

  ws.on('close', () => {
    if (ws._hostId && hosts.get(ws._hostId) === ws) hosts.delete(ws._hostId);
    unlinkPeers(ws, true);
    dropPendingFor(ws);
  });

  ws.on('error', () => {
    /* handled by close */
  });
});

// Heartbeat to reap dead connections.
const interval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws._alive === false) return ws.terminate();
    ws._alive = false;
    try {
      ws.ping();
    } catch {
      /* ignore */
    }
  });
}, 30000);

wss.on('close', () => clearInterval(interval));

server.listen(PORT, HOST, () => {
  // eslint-disable-next-line no-console
  console.log(`EnDesk relay listening on ws://${HOST}:${PORT}  (health: http://${HOST}:${PORT}/health)`);
});
