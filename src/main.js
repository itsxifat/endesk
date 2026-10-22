'use strict';

const {
  app,
  BrowserWindow,
  ipcMain,
  desktopCapturer,
  screen,
  systemPreferences,
  shell,
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
        if (ev.key) robot.keyToggle(ev.key, 'down');
        break;
      case 'ku':
        if (ev.key) robot.keyToggle(ev.key, 'up');
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
    backgroundColor: '#0f1221',
    title: 'EnDesk',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ---------------------------------------------------------------------------
// IPC surface.
// ---------------------------------------------------------------------------
ipcMain.handle('endesk:init', () => {
  const cfg = loadConfig();
  const deviceId = ensureDeviceId(cfg);
  return {
    deviceId,
    relayUrl: cfg.relayUrl || 'ws://localhost:8080',
    unattendedPassword: cfg.unattendedPassword || '',
    autoAccept: !!cfg.autoAccept,
    platform: process.platform,
    canHost: !!robot,
    robotError: robotError ? String(robotError.message || robotError) : null,
    permissions: permissionStatus(),
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
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
