'use strict';

/* global EndeskKeymap */

// ===========================================================================
// EnDesk renderer: UI + signaling client + WebRTC (host & viewer) + input.
// ===========================================================================

const $ = (id) => document.getElementById(id);
const ICE = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:global.stun.twilio.com:3478' }] };

const state = {
  cfg: null,
  ws: null,
  wsReady: false,
  wsReconnectTimer: null,
  role: null, // 'host' | 'viewer' | null
  pc: null,
  turnServers: [], // short-lived TURN credentials from the relay, per session
  inputChannel: null,
  localStream: null,
  pendingRid: null, // host: rid of a join awaiting accept
  remoteDescSet: false,
  iceQueue: [],
  sessionPw: '',
  currentView: 'home',
  pressedKeys: new Set(),
  lastMoveSent: 0,
};

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------
function randomPassword(len = 6) {
  const alphabet = 'abcdefghijkmnpqrstuvwxyz23456789'; // no ambiguous chars
  let out = '';
  const buf = new Uint32Array(len);
  crypto.getRandomValues(buf);
  for (let i = 0; i < len; i++) out += alphabet[buf[i] % alphabet.length];
  return out;
}

function formatId(id) {
  return String(id).replace(/(\d{3})(?=\d)/g, '$1 ').trim();
}

function setPill(el, text, on) {
  el.textContent = text;
  el.classList.remove('pill-on', 'pill-off');
  if (on === true) el.classList.add('pill-on');
  else if (on === false) el.classList.add('pill-off');
}

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------
function showView(name) {
  state.currentView = name;
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.dataset.view === name));
  document.querySelectorAll('.nav-btn').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
}

document.querySelectorAll('.nav-btn').forEach((btn) => {
  btn.addEventListener('click', () => showView(btn.dataset.view));
});

// ---------------------------------------------------------------------------
// Signaling (WebSocket to relay)
// ---------------------------------------------------------------------------
function wsSend(obj) {
  if (state.ws && state.wsReady) {
    try {
      state.ws.send(JSON.stringify(obj));
    } catch (e) {
      console.warn('ws send failed', e);
    }
  }
}

function connectRelay() {
  const url = state.cfg.relayUrl;
  if (!url) return;
  clearTimeout(state.wsReconnectTimer);
  try {
    if (state.ws) {
      state.ws.onclose = null;
      state.ws.close();
    }
  } catch { /* ignore */ }

  setPill($('relayStatus'), 'connecting', null);
  let ws;
  try {
    ws = new WebSocket(url);
  } catch (e) {
    setPill($('relayStatus'), 'bad url', false);
    return;
  }
  state.ws = ws;

  ws.onopen = () => {
    state.wsReady = true;
    setPill($('relayStatus'), 'online', true);
    // Register this device as a reachable host.
    wsSend({ type: 'host', id: state.cfg.deviceId, key: state.cfg.deviceKey });
  };

  ws.onclose = () => {
    state.wsReady = false;
    setPill($('relayStatus'), 'offline', false);
    // Auto-retry.
    state.wsReconnectTimer = setTimeout(connectRelay, 2500);
  };

  ws.onerror = () => {
    setPill($('relayStatus'), 'error', false);
  };

  ws.onmessage = (evt) => {
    let msg;
    try {
      msg = JSON.parse(evt.data);
    } catch {
      return;
    }
    handleSignal(msg);
  };
}

function handleSignal(msg) {
  switch (msg.type) {
    case 'host-ok':
      break;

    case 'error':
      if (msg.code === 'id-taken') {
        // Another device already owns this ID (e.g. a copied config): take a new one.
        window.endesk.resetDeviceId().then((r) => {
          state.cfg.deviceId = r.deviceId;
          state.cfg.deviceKey = r.deviceKey;
          $('deviceId').textContent = formatId(r.deviceId);
          wsSend({ type: 'host', id: r.deviceId, key: r.deviceKey });
        });
        break;
      }
      if (state.role === 'viewer' || !state.role) {
        showConnectMsg(msg.message || msg.code || 'Connection error', true);
        if (msg.code === 'not-found' || msg.code === 'busy') resetSession(false);
      }
      break;

    // ---- Host receives an incoming join request ----
    case 'join-request':
      onJoinRequest(msg);
      break;

    // ---- Viewer: host rejected ----
    case 'rejected':
      showConnectMsg('Connection rejected' + (msg.reason ? ' (' + msg.reason + ')' : ''), true);
      resetSession(false);
      break;

    // ---- Both: the session is approved; begin WebRTC ----
    case 'session-begin':
      state.turnServers = Array.isArray(msg.iceServers) ? msg.iceServers : [];
      beginSession(msg.role);
      break;

    // ---- Relayed WebRTC signaling ----
    case 'signal':
      onRtcSignal(msg.data);
      break;

    case 'peer-left':
      if (state.role === 'viewer') {
        setOverlay('The remote device ended the session.');
        setTimeout(() => resetSession(true), 1200);
      } else {
        endHosting();
      }
      break;

    default:
      break;
  }
}

// ---------------------------------------------------------------------------
// HOST: handle incoming connection requests
// ---------------------------------------------------------------------------
function passwordValid(pw) {
  if (!pw) return false;
  if (state.sessionPw && pw === state.sessionPw) return true;
  if (state.cfg.unattendedPassword && pw === state.cfg.unattendedPassword) return true;
  return false;
}

function onJoinRequest(msg) {
  if (!state.cfg.canHost) {
    wsSend({ type: 'join-decision', rid: msg.rid, accept: false, reason: 'host-unavailable' });
    return;
  }
  if (state.role) {
    wsSend({ type: 'join-decision', rid: msg.rid, accept: false, reason: 'busy' });
    return;
  }
  if (!passwordValid(msg.password)) {
    wsSend({ type: 'join-decision', rid: msg.rid, accept: false, reason: 'bad-password' });
    return;
  }

  if (state.cfg.autoAccept) {
    wsSend({ type: 'join-decision', rid: msg.rid, accept: true });
    return;
  }

  // Attended: ask the user on this machine.
  state.pendingRid = msg.rid;
  showView('home');
  $('incomingFrom').textContent = '· someone entered the correct password';
  $('incoming').classList.remove('hidden');
}

$('acceptConn').addEventListener('click', () => {
  if (state.pendingRid) {
    wsSend({ type: 'join-decision', rid: state.pendingRid, accept: true });
    state.pendingRid = null;
    $('incoming').classList.add('hidden');
  }
});
$('rejectConn').addEventListener('click', () => {
  if (state.pendingRid) {
    wsSend({ type: 'join-decision', rid: state.pendingRid, accept: false, reason: 'declined' });
    state.pendingRid = null;
    $('incoming').classList.add('hidden');
  }
});

// ---------------------------------------------------------------------------
// WebRTC lifecycle
// ---------------------------------------------------------------------------
function newPeerConnection() {
  const pc = new RTCPeerConnection({ iceServers: ICE.iceServers.concat(state.turnServers) });
  state.remoteDescSet = false;
  state.iceQueue = [];
  pc.onicecandidate = (e) => {
    if (e.candidate) wsSend({ type: 'signal', data: { candidate: e.candidate } });
  };
  pc.onconnectionstatechange = () => {
    const st = pc.connectionState;
    if (state.role === 'viewer') {
      if (st === 'connected') setOverlay(null);
      else if (st === 'failed') setOverlay('Connection failed — the two devices could not reach each other.\nA TURN server may be required on restrictive networks.');
      else if (st === 'disconnected') setOverlay('Connection lost…');
    }
  };
  return pc;
}

async function beginSession(role) {
  state.role = role;
  if (role === 'host') {
    await startHosting();
  } else {
    startViewing();
  }
}

// ---- HOST side: capture screen, offer, receive input ----
async function startHosting() {
  try {
    const sources = await window.endesk.getSources();
    if (!sources.length) throw new Error('No screen available to capture');
    const sourceId = sources[0].id;

    state.localStream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        mandatory: {
          chromeMediaSource: 'desktop',
          chromeMediaSourceId: sourceId,
          maxWidth: 1920,
          maxHeight: 1080,
          maxFrameRate: 30,
        },
      },
    });

    const pc = newPeerConnection();
    state.pc = pc;
    state.localStream.getTracks().forEach((t) => pc.addTrack(t, state.localStream));

    // Data channel for input, created by the offerer (host).
    const ch = pc.createDataChannel('input', { ordered: true });
    state.inputChannel = ch;
    ch.onmessage = (e) => {
      let ev;
      try {
        ev = JSON.parse(e.data);
      } catch {
        return;
      }
      window.endesk.sendInput(ev);
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    wsSend({ type: 'signal', data: { sdp: pc.localDescription } });

    $('hostLive').classList.remove('hidden');
    $('incoming').classList.add('hidden');
  } catch (err) {
    console.error('startHosting failed', err);
    alert('Could not start screen sharing: ' + err.message +
      (window.endesk && state.cfg.platform === 'darwin'
        ? '\n\nOn macOS, grant Screen Recording permission in System Settings and relaunch EnDesk.'
        : ''));
    wsSend({ type: 'bye' });
    resetSession(false);
  }
}

function endHosting() {
  $('hostLive').classList.add('hidden');
  teardownRtc();
  state.role = null;
}

$('hostStop').addEventListener('click', () => {
  wsSend({ type: 'bye' });
  endHosting();
});

// ---- VIEWER side: receive video, answer, send input ----
function startViewing() {
  showView('viewer');
  setOverlay('Negotiating connection…');
  $('viewerTarget').textContent = 'Controlling ' + formatId($('remoteId').value.replace(/\s/g, ''));

  const pc = newPeerConnection();
  state.pc = pc;

  pc.ontrack = (e) => {
    const v = $('remoteVideo');
    if (v.srcObject !== e.streams[0]) v.srcObject = e.streams[0];
  };

  pc.ondatachannel = (e) => {
    if (e.channel.label !== 'input') return;
    state.inputChannel = e.channel;
    state.inputChannel.onopen = () => {
      // Control is available once the channel opens.
    };
  };
  // Viewer waits for the host's offer (arrives via onRtcSignal).
}

async function onRtcSignal(data) {
  const pc = state.pc;
  if (!pc || !data) return;

  if (data.sdp) {
    await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
    state.remoteDescSet = true;
    // Flush queued ICE candidates.
    for (const c of state.iceQueue) {
      try {
        await pc.addIceCandidate(new RTCIceCandidate(c));
      } catch (e) {
        console.warn('addIceCandidate (queued) failed', e);
      }
    }
    state.iceQueue = [];

    if (data.sdp.type === 'offer') {
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      wsSend({ type: 'signal', data: { sdp: pc.localDescription } });
    }
  } else if (data.candidate) {
    if (state.remoteDescSet) {
      try {
        await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
      } catch (e) {
        console.warn('addIceCandidate failed', e);
      }
    } else {
      state.iceQueue.push(data.candidate);
    }
  }
}

function teardownRtc() {
  if (state.inputChannel) {
    try { state.inputChannel.close(); } catch { /* ignore */ }
    state.inputChannel = null;
  }
  if (state.pc) {
    try { state.pc.close(); } catch { /* ignore */ }
    state.pc = null;
  }
  if (state.localStream) {
    state.localStream.getTracks().forEach((t) => t.stop());
    state.localStream = null;
  }
  const v = $('remoteVideo');
  if (v.srcObject) {
    v.srcObject = null;
  }
  releaseAllKeys();
}

function resetSession(goHome) {
  teardownRtc();
  state.role = null;
  state.pendingRid = null;
  $('hostLive').classList.add('hidden');
  $('incoming').classList.add('hidden');
  if (goHome) showView('home');
}

// ---------------------------------------------------------------------------
// VIEWER: connect button
// ---------------------------------------------------------------------------
function showConnectMsg(text, isErr) {
  const el = $('connectMsg');
  el.textContent = text;
  el.className = 'connect-msg ' + (isErr ? 'err' : 'ok');
}

$('connectBtn').addEventListener('click', () => {
  const id = $('remoteId').value.replace(/\D/g, '');
  const pw = $('remotePw').value;
  if (id.length < 6) return showConnectMsg('Enter a valid remote ID.', true);
  if (!pw) return showConnectMsg('Enter the password.', true);
  if (!state.wsReady) return showConnectMsg('Not connected to the relay server. Check Settings.', true);
  if (id === state.cfg.deviceId) return showConnectMsg('That is this device’s own ID.', true);

  state.role = 'viewer';
  showConnectMsg('Connecting…', false);
  wsSend({ type: 'join', id, password: pw });
});

$('viewerDisconnect').addEventListener('click', () => {
  wsSend({ type: 'bye' });
  resetSession(true);
  showConnectMsg('', false);
});

// ---------------------------------------------------------------------------
// VIEWER: input capture -> data channel
// ---------------------------------------------------------------------------
function sendInput(obj) {
  const ch = state.inputChannel;
  if (ch && ch.readyState === 'open') {
    try {
      ch.send(JSON.stringify(obj));
    } catch { /* ignore */ }
  }
}

function controlActive() {
  return state.role === 'viewer' && state.currentView === 'viewer' && $('ctrlEnabled').checked;
}

function normCoords(e) {
  const v = $('remoteVideo');
  const r = v.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return null;
  const x = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
  const y = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
  return { x, y };
}

const video = $('remoteVideo');

video.addEventListener('mousemove', (e) => {
  if (!controlActive()) return;
  const now = performance.now();
  if (now - state.lastMoveSent < 16) return; // ~60 Hz cap
  state.lastMoveSent = now;
  const c = normCoords(e);
  if (c) sendInput({ t: 'm', x: c.x, y: c.y });
});

video.addEventListener('mousedown', (e) => {
  if (!controlActive()) return;
  e.preventDefault();
  const c = normCoords(e);
  sendInput({ t: 'd', b: e.button, x: c ? c.x : undefined, y: c ? c.y : undefined });
});

video.addEventListener('mouseup', (e) => {
  if (!controlActive()) return;
  e.preventDefault();
  const c = normCoords(e);
  sendInput({ t: 'u', b: e.button, x: c ? c.x : undefined, y: c ? c.y : undefined });
});

video.addEventListener('contextmenu', (e) => {
  if (controlActive()) e.preventDefault();
});

video.addEventListener('wheel', (e) => {
  if (!controlActive()) return;
  e.preventDefault();
  const dy = Math.max(-50, Math.min(50, Math.round(-e.deltaY / 40))) || (e.deltaY > 0 ? -1 : 1);
  const dx = Math.max(-50, Math.min(50, Math.round(-e.deltaX / 40)));
  sendInput({ t: 'w', dx, dy });
}, { passive: false });

function onKey(e, down) {
  if (!controlActive()) return;
  const swap = $('swapCmd').checked;
  const name = EndeskKeymap.mapCode(e.code, swap);
  if (!name) return;
  e.preventDefault();
  e.stopPropagation();
  if (down) {
    state.pressedKeys.add(name);
    sendInput({ t: 'kd', key: name });
  } else {
    state.pressedKeys.delete(name);
    sendInput({ t: 'ku', key: name });
  }
}

window.addEventListener('keydown', (e) => onKey(e, true), true);
window.addEventListener('keyup', (e) => onKey(e, false), true);

function releaseAllKeys() {
  for (const name of state.pressedKeys) sendInput({ t: 'ku', key: name });
  state.pressedKeys.clear();
}
// Avoid stuck modifiers when focus leaves the window mid-press.
window.addEventListener('blur', releaseAllKeys);

$('sendCad').addEventListener('click', () => {
  if (state.role !== 'viewer') return;
  const seq = ['control', 'alt', 'delete'];
  seq.forEach((k) => sendInput({ t: 'kd', key: k }));
  seq.slice().reverse().forEach((k) => sendInput({ t: 'ku', key: k }));
});

$('fitScreen').addEventListener('change', (e) => {
  $('remoteVideo').classList.toggle('actual', !e.target.checked);
});

function setOverlay(text) {
  const ov = $('viewerOverlay');
  if (text == null) {
    ov.classList.add('hidden');
  } else {
    ov.textContent = text;
    ov.classList.remove('hidden');
  }
}

// ---------------------------------------------------------------------------
// Home: password + settings
// ---------------------------------------------------------------------------
function refreshSessionPassword() {
  state.sessionPw = state.cfg.unattendedPassword
    ? state.cfg.unattendedPassword
    : randomPassword(6);
  $('sessionPw').textContent = state.sessionPw;
}

$('regenPw').addEventListener('click', () => {
  state.sessionPw = randomPassword(6);
  // Regenerating always produces a fresh session password (independent of the
  // permanent one, which still works on its own).
  $('sessionPw').textContent = state.sessionPw;
});

$('autoAccept').addEventListener('change', (e) => {
  state.cfg.autoAccept = e.target.checked;
  window.endesk.saveSettings({ autoAccept: e.target.checked });
});

$('saveSettings').addEventListener('click', async () => {
  const relayUrl = $('relayUrl').value.trim();
  const unattendedPassword = $('unattendedPw').value;
  state.cfg.relayUrl = relayUrl;
  state.cfg.unattendedPassword = unattendedPassword;
  await window.endesk.saveSettings({ relayUrl, unattendedPassword });
  $('settingsSaved').textContent = 'Saved';
  setTimeout(() => ($('settingsSaved').textContent = ''), 1600);
  refreshSessionPassword();
  connectRelay();
});

// ---------------------------------------------------------------------------
// macOS permissions
// ---------------------------------------------------------------------------
function applyPermissions(p) {
  if (!p || p.platform !== 'darwin') {
    $('permWarn').classList.add('hidden');
    return;
  }
  const scrOk = p.screen === 'granted';
  const accOk = p.accessibility === 'granted';
  setPill($('permScreen'), p.screen, scrOk);
  setPill($('permAcc'), p.accessibility, accOk);
  $('permWarn').classList.toggle('hidden', scrOk && accOk);
}

$('grantScreen').addEventListener('click', async () => {
  const p = await window.endesk.requestScreenPermission();
  applyPermissions(p);
  window.endesk.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
});
$('grantAcc').addEventListener('click', async () => {
  const p = await window.endesk.requestAccessibilityPermission();
  applyPermissions(p);
  window.endesk.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility');
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
async function boot() {
  state.cfg = await window.endesk.init();

  $('deviceId').textContent = formatId(state.cfg.deviceId);
  $('relayUrl').value = state.cfg.relayUrl;
  $('unattendedPw').value = state.cfg.unattendedPassword || '';
  $('autoAccept').checked = !!state.cfg.autoAccept;

  setPill($('hostCap'), state.cfg.canHost ? 'allowed' : 'unavailable', state.cfg.canHost);

  refreshSessionPassword();
  applyPermissions(state.cfg.permissions);
  connectRelay();

  // Re-poll permissions when returning to the window (after granting).
  window.addEventListener('focus', async () => {
    if (state.cfg.platform === 'darwin') {
      const p = await window.endesk.getPermissions();
      applyPermissions(p);
    }
  });
}

boot();
