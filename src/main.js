'use strict';

const {
  app,
  BrowserWindow,
  ipcMain,
  desktopCapturer,
  screen,
  systemPreferences,
  shell,
  nativeTheme,
  net,
} = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// ---------------------------------------------------------------------------
// Native input injection (robotjs). Loaded lazily and guarded so the app still
// launches (e.g. for the viewer role, or on a platform without a prebuilt
// binary) even if the native module cannot be initialised.
// ---------------------------------------------------------------------------
let robot = null;
let robotError = null;
try {
  robot = require('@jitsi/robotjs');
  robot.setMouseDelay(0);
  robot.setKeyboardDelay(0);
} catch (err) {
  robotError = err;
  // eslint-disable-next-line no-console
  console.warn('[endesk] robotjs unavailable – remote control of THIS device is disabled:', err.message);
}

// ---------------------------------------------------------------------------
// Tiny persistent config store (userData/config.json).
// Keeps the device ID stable across restarts and remembers the relay URL /
// unattended password.
// ---------------------------------------------------------------------------
const CONFIG_PATH = () => path.join(app.getPath('userData'), 'config.json');

// Public relay used until the user picks another one in Settings.
const DEFAULT_RELAY_URL = process.env.ENDESK_RELAY_URL || 'wss://endesk.enfinito.cloud/relay';

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH(), 'utf8'));
  } catch {
    return {};
  }
}

function saveConfig(cfg) {
  try {
    fs.writeFileSync(CONFIG_PATH(), JSON.stringify(cfg, null, 2));
  } catch (err) {
    console.error('[endesk] failed to persist config:', err.message);
  }
}

function ensureDeviceId(cfg) {
  if (!cfg.deviceId || !/^\d{9}$/.test(cfg.deviceId)) {
    // 9-digit human-friendly ID, AnyDesk style.
    let id = '';
    for (let i = 0; i < 9; i++) id += Math.floor(Math.random() * 10);
    if (id[0] === '0') id = '1' + id.slice(1);
    cfg.deviceId = id;
    // Secret that proves to the relay this device owns its ID.
    cfg.deviceKey = crypto.randomBytes(32).toString('hex');
    saveConfig(cfg);
  }
  if (!cfg.deviceKey) {
    cfg.deviceKey = crypto.randomBytes(32).toString('hex');
    saveConfig(cfg);
  }
  return cfg.deviceId;
}

// ---------------------------------------------------------------------------
// Mouse button normalisation.
// ---------------------------------------------------------------------------
const BUTTONS = { 0: 'left', 1: 'middle', 2: 'right', left: 'left', middle: 'middle', right: 'right' };

function screenSize() {
  if (robot) {
    try {
      return robot.getScreenSize();
    } catch {
      /* fall through */
    }
  }
  const s = screen.getPrimaryDisplay().size;
  return { width: s.width, height: s.height };
}

// ---------------------------------------------------------------------------
// Keyboard. Keys held down by the remote viewer are tracked so modifiers can be
// applied and everything is released when a session ends.
// ---------------------------------------------------------------------------
const heldKeys = new Set();
const MODIFIER_KEYS = new Set(['shift', 'right_shift', 'control', 'left_control', 'right_control', 'alt', 'right_alt', 'command']);

function toggleKey(key, down) {
  if (down) heldKeys.add(key);
  else heldKeys.delete(key);
  if (process.platform === 'darwin') {
    // macOS stamps every injected key event with an explicit modifier mask, so
    // the held modifiers must be passed along or Shift/⌘/⌥/⌃ are lost.
    // Windows tracks modifier state itself from the separate key presses.
    const mods = [...heldKeys].filter((k) => MODIFIER_KEYS.has(k));
    robot.keyToggle(key, down ? 'down' : 'up', mods);
  } else {
    robot.keyToggle(key, down ? 'down' : 'up');
  }
}

function releaseHeldKeys() {
  if (!robot) return;
  for (const key of [...heldKeys]) {
    try {
      toggleKey(key, false);
    } catch {
      heldKeys.delete(key);
    }
  }
}

// Inject a single input event coming from the remote viewer.
// Coordinates arrive normalised (0..1) relative to the captured screen, so we
// scale them to whatever resolution/DPI this machine actually uses. This is
// what makes control work across mismatched displays (Windows <-> Mac).
function injectInput(ev) {
  if (!robot || !ev || typeof ev !== 'object') return;
  try {
    const needsMove =
      (ev.t === 'm' || ev.t === 'd' || ev.t === 'u' || ev.t === 'c') &&
      typeof ev.x === 'number' &&
      typeof ev.y === 'number';
    if (needsMove) {
      const s = screenSize();
      const x = Math.max(0, Math.min(s.width - 1, Math.round(ev.x * s.width)));
      const y = Math.max(0, Math.min(s.height - 1, Math.round(ev.y * s.height)));
      robot.moveMouse(x, y);
    }

    switch (ev.t) {
      case 'm':
        break;
      case 'd':
        robot.mouseToggle('down', BUTTONS[ev.b] || 'left');
        break;
      case 'u':
        robot.mouseToggle('up', BUTTONS[ev.b] || 'left');
        break;
      case 'c':
        robot.mouseClick(BUTTONS[ev.b] || 'left', !!ev.double);
        break;
      case 'w':
        robot.scrollMouse(Math.round(ev.dx || 0), Math.round(ev.dy || 0));
        break;
      case 'kd':
        if (typeof ev.key === 'string') toggleKey(ev.key, true);
        break;
      case 'ku':
        if (typeof ev.key === 'string') toggleKey(ev.key, false);
        break;
      case 'type':
        if (typeof ev.s === 'string') robot.typeString(ev.s);
        break;
      default:
        break;
    }
  } catch (err) {
    // A single bad key name must never crash the session.
    console.warn('[endesk] inject error:', err.message);
  }
}

// ---------------------------------------------------------------------------
// macOS permission helpers.
// ---------------------------------------------------------------------------
function permissionStatus() {
  if (process.platform !== 'darwin') {
    return { platform: process.platform, screen: 'granted', accessibility: 'granted' };
  }
  let scr = 'unknown';
  try {
    scr = systemPreferences.getMediaAccessStatus('screen');
  } catch {
    /* ignore */
  }
  let acc = 'unknown';
  try {
    acc = systemPreferences.isTrustedAccessibilityClient(false) ? 'granted' : 'denied';
  } catch {
    /* ignore */
  }
  return { platform: 'darwin', screen: scr, accessibility: acc };
}

// ---------------------------------------------------------------------------
// Window.
// ---------------------------------------------------------------------------
let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 840,
    minHeight: 560,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0b0b0b' : '#ffffff',
    title: 'EnDesk',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  // No menu bar on Windows/Linux: Alt would otherwise pop it up mid-session.
  if (process.platform !== 'darwin') mainWindow.removeMenu();

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.on('focus', updateKeyCapture);
  mainWindow.on('blur', updateKeyCapture);
  mainWindow.on('closed', () => {
    mainWindow = null;
    updateKeyCapture();
  });
}

// ---------------------------------------------------------------------------
// System keys while controlling (Windows): Windows key, Alt+Tab, Alt+F4, ...
// are taken from Windows only while a session has control and EnDesk is the
// focused window.
// ---------------------------------------------------------------------------
let keyHook = null;
let keyCaptureWanted = false;

function updateKeyCapture() {
  if (process.platform !== 'win32') return;
  const on = keyCaptureWanted && !!mainWindow && mainWindow.isFocused();
  try {
    if (!on) {
      if (keyHook) keyHook.stop();
      return;
    }
    if (!keyHook) keyHook = require('./keyhook-win');
    keyHook.start((code, down) => {
      if (mainWindow) mainWindow.webContents.send('endesk:hook-key', { code, down });
    });
  } catch (err) {
    console.warn('[endesk] keyboard hook unavailable:', err.message);
  }
}

// ---------------------------------------------------------------------------
// Updates. The Windows installer updates itself (electron-updater, from the
// same server as the downloads) and restarts when no session is running.
// macOS and the portable exe can't replace themselves without a paid signing
// certificate, so they show a banner linking to the new download instead.
// ---------------------------------------------------------------------------
const UPDATE_FEED = 'https://endesk.enfinito.cloud/downloads/';
const UPDATE_EVERY = 4 * 60 * 60 * 1000;
let autoUpdater = null;
let updateReady = null; // version downloaded and waiting to install
let lastUpdate = null; // last state sent to the window
let sessionActive = false;

function notifyUpdate(info) {
  lastUpdate = info;
  if (mainWindow) mainWindow.webContents.send('endesk:update', info);
}

function newerThan(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  }
  return false;
}

function installUpdateIfIdle() {
  if (!updateReady) return;
  if (sessionActive) {
    notifyUpdate({ state: 'ready', version: updateReady });
    return;
  }
  notifyUpdate({ state: 'installing', version: updateReady });
  // A moment to read the banner, then restart into the new version silently.
  setTimeout(() => {
    if (!sessionActive) autoUpdater.quitAndInstall(true, true);
    else notifyUpdate({ state: 'ready', version: updateReady });
  }, 8000);
}

async function checkLatestRelease() {
  try {
    const res = await net.fetch(UPDATE_FEED + 'latest.json', { cache: 'no-cache' });
    const latest = await res.json();
    const name = process.platform === 'darwin' ? 'EnDesk-mac.dmg' : 'EnDesk-Portable.exe';
    const entry = latest.files && latest.files[name];
    const version = entry && entry.file.split('/')[0];
    if (version && newerThan(version, app.getVersion())) {
      notifyUpdate({ state: 'available', version, url: UPDATE_FEED + name });
    }
  } catch {
    /* offline or server busy: try again next time */
  }
}

function setupUpdates() {
  if (!app.isPackaged) return;
  const portable = !!process.env.PORTABLE_EXECUTABLE_DIR;
  if (process.platform === 'win32' && !portable) {
    ({ autoUpdater } = require('electron-updater'));
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.on('update-downloaded', (info) => {
      updateReady = info.version;
      installUpdateIfIdle();
    });
    autoUpdater.on('error', (err) => console.warn('[endesk] update failed:', err.message));
    const check = () => autoUpdater.checkForUpdates().catch(() => {});
    check();
    setInterval(check, UPDATE_EVERY);
  } else {
    checkLatestRelease();
    setInterval(checkLatestRelease, UPDATE_EVERY);
  }
}

// ---------------------------------------------------------------------------
// IPC surface.
// ---------------------------------------------------------------------------
ipcMain.handle('endesk:init', () => {
  const cfg = loadConfig();
  const deviceId = ensureDeviceId(cfg);
  return {
    deviceId,
    deviceKey: cfg.deviceKey,
    relayUrl: cfg.relayUrl || DEFAULT_RELAY_URL,
    unattendedPassword: cfg.unattendedPassword || '',
    autoAccept: !!cfg.autoAccept,
    platform: process.platform,
    canHost: !!robot,
    robotError: robotError ? String(robotError.message || robotError) : null,
    permissions: permissionStatus(),
    version: app.getVersion(),
    update: lastUpdate,
  };
});

ipcMain.handle('endesk:save-settings', (_e, patch) => {
  const cfg = loadConfig();
  if (patch && typeof patch === 'object') {
    if (typeof patch.relayUrl === 'string') cfg.relayUrl = patch.relayUrl.trim();
    if (typeof patch.unattendedPassword === 'string') cfg.unattendedPassword = patch.unattendedPassword;
    if (typeof patch.autoAccept === 'boolean') cfg.autoAccept = patch.autoAccept;
  }
  saveConfig(cfg);
  return { ok: true };
});

// The relay reported that another device owns this ID: pick a fresh one.
ipcMain.handle('endesk:reset-device-id', () => {
  const cfg = loadConfig();
  delete cfg.deviceId;
  delete cfg.deviceKey;
  const deviceId = ensureDeviceId(cfg);
  return { deviceId, deviceKey: cfg.deviceKey };
});

ipcMain.handle('endesk:get-sources', async () => {
  // Returns the available screens so the host can capture one.
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: 160, height: 100 },
  });
  return sources.map((s) => ({
    id: s.id,
    name: s.name,
    thumbnail: s.thumbnail ? s.thumbnail.toDataURL() : null,
  }));
});

ipcMain.handle('endesk:screen-size', () => screenSize());

ipcMain.handle('endesk:permissions', () => permissionStatus());

ipcMain.handle('endesk:request-screen-permission', async () => {
  if (process.platform !== 'darwin') return { ok: true };
  try {
    // Triggers the system Screen Recording prompt the first time.
    await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } });
  } catch {
    /* ignore */
  }
  return permissionStatus();
});

ipcMain.handle('endesk:request-accessibility-permission', () => {
  if (process.platform !== 'darwin') return { ok: true };
  try {
    // Passing true prompts the user and opens System Settings.
    systemPreferences.isTrustedAccessibilityClient(true);
  } catch {
    /* ignore */
  }
  return permissionStatus();
});

ipcMain.handle('endesk:open-external', (_e, url) => {
  if (typeof url === 'string' && /^https?:\/\//.test(url)) shell.openExternal(url);
  return { ok: true };
});

// Input is sent one event at a time (fire-and-forget) for lowest latency.
ipcMain.on('endesk:input', (_e, ev) => injectInput(ev));

// Session over: let go of any key the remote viewer was still holding.
ipcMain.on('endesk:release-input', () => releaseHeldKeys());

ipcMain.on('endesk:key-capture', (_e, on) => {
  keyCaptureWanted = !!on;
  updateKeyCapture();
});

ipcMain.on('endesk:session-active', (_e, active) => {
  sessionActive = !!active;
  if (!sessionActive) installUpdateIfIdle();
});

// ---------------------------------------------------------------------------
// App lifecycle.
// ---------------------------------------------------------------------------
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    createWindow();
    setupUpdates();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
