'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Safe, minimal bridge exposed to the renderer. No Node APIs leak through.
contextBridge.exposeInMainWorld('endesk', {
  init: () => ipcRenderer.invoke('endesk:init'),
  saveSettings: (patch) => ipcRenderer.invoke('endesk:save-settings', patch),
  resetDeviceId: () => ipcRenderer.invoke('endesk:reset-device-id'),
  getSources: () => ipcRenderer.invoke('endesk:get-sources'),
  getScreenSize: () => ipcRenderer.invoke('endesk:screen-size'),
  getPermissions: () => ipcRenderer.invoke('endesk:permissions'),
  requestScreenPermission: () => ipcRenderer.invoke('endesk:request-screen-permission'),
  requestAccessibilityPermission: () => ipcRenderer.invoke('endesk:request-accessibility-permission'),
  openExternal: (url) => ipcRenderer.invoke('endesk:open-external', url),
  // Fire-and-forget input injection on the host side.
  sendInput: (ev) => ipcRenderer.send('endesk:input', ev),
  releaseInput: () => ipcRenderer.send('endesk:release-input'),
  // Viewer: take system keys (Windows key, Alt+Tab, ...) while controlling.
  setKeyCapture: (on) => ipcRenderer.send('endesk:key-capture', !!on),
  onHookKey: (cb) => ipcRenderer.on('endesk:hook-key', (_e, k) => cb(k)),
  setSessionActive: (active) => ipcRenderer.send('endesk:session-active', !!active),
  onUpdate: (cb) => ipcRenderer.on('endesk:update', (_e, info) => cb(info)),
});
