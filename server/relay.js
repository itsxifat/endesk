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
// ===========================================================================

const http = require('http');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = parseInt(process.env.PORT || '8080', 10);
const HOST = process.env.HOST || '0.0.0.0';

const hosts = new Map(); // deviceId -> ws (a reachable host)
const pending = new Map(); // rid -> { viewer, host }

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, hosts: hosts.size, pending: pending.size }));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('EnDesk relay is running. Connect an EnDesk client to ws(s)://<this-host>:' + PORT);
});

const wss = new WebSocketServer({ server });

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

wss.on('connection', (ws) => {
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
        if (!id) return;
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
          send(ws, { type: 'session-begin', role: 'host' });
          send(p.viewer, { type: 'session-begin', role: 'viewer' });
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
