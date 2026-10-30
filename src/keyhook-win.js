'use strict';

// ===========================================================================
// Windows-only low-level keyboard hook for the viewer.
//
// Windows handles the Windows key, Alt+Tab, Alt+F4, Ctrl+Esc, PrintScreen and
// Win+<key> shortcuts itself, before the EnDesk window ever sees them. While
// you control a remote computer (and EnDesk is the focused window) this hook
// swallows those keys locally and hands them to EnDesk instead, so they reach
// the remote computer, like a desktop remote-control client should.
// ===========================================================================

const koffi = require('koffi');

const user32 = koffi.load('user32.dll');
const kernel32 = koffi.load('kernel32.dll');

const KBDLLHOOKSTRUCT = koffi.struct('KBDLLHOOKSTRUCT', {
  vkCode: 'uint32',
  scanCode: 'uint32',
  flags: 'uint32',
  time: 'uint32',
  dwExtraInfo: 'uintptr',
});
const LowLevelKeyboardProc = koffi.proto('intptr __stdcall LowLevelKeyboardProc(int nCode, uintptr wParam, void *lParam)');
const SetWindowsHookExW = user32.func('void * __stdcall SetWindowsHookExW(int idHook, LowLevelKeyboardProc *lpfn, void *hmod, uint32 dwThreadId)');
const UnhookWindowsHookEx = user32.func('bool __stdcall UnhookWindowsHookEx(void *hhk)');
const CallNextHookEx = user32.func('intptr __stdcall CallNextHookEx(void *hhk, int nCode, uintptr wParam, void *lParam)');
const GetAsyncKeyState = user32.func('short __stdcall GetAsyncKeyState(int vKey)');
const GetModuleHandleW = kernel32.func('void * __stdcall GetModuleHandleW(const char16_t *name)');

const WH_KEYBOARD_LL = 13;
const WM_KEYUP = 0x0101;
const WM_SYSKEYUP = 0x0105;
const LLKHF_INJECTED = 0x10;
const LLKHF_ALTDOWN = 0x20;
const VK_CONTROL = 0x11;

// Keys taken over from Windows, as KeyboardEvent.code names.
const CODES = {
  0x5b: 'MetaLeft',
  0x5c: 'MetaRight',
  0x09: 'Tab',
  0x1b: 'Escape',
  0x73: 'F4',
  0x20: 'Space',
  0x2c: 'PrintScreen',
};

let hook = null;
let callback = null;
let onKey = null;
const captured = new Set(); // vk codes whose key-down we swallowed

function shouldCapture(vk, flags, isUp) {
  if (captured.has(vk)) return true; // always swallow the matching key-up
  if (isUp) return false;
  if (vk === 0x5b || vk === 0x5c || vk === 0x2c) return true; // Windows keys, PrintScreen
  const alt = (flags & LLKHF_ALTDOWN) !== 0;
  const ctrl = (GetAsyncKeyState(VK_CONTROL) & 0x8000) !== 0;
  if (alt && (vk === 0x09 || vk === 0x1b || vk === 0x73 || vk === 0x20)) return true; // Alt+Tab/Esc/F4/Space
  if (ctrl && vk === 0x1b) return true; // Ctrl+Esc, Ctrl+Shift+Esc
  return false;
}

function proc(nCode, wParam, lParam) {
  if (nCode >= 0) {
    try {
      const info = koffi.decode(lParam, KBDLLHOOKSTRUCT);
      const isUp = wParam === WM_KEYUP || wParam === WM_SYSKEYUP;
      // Ignore synthetic input (e.g. from EnDesk itself while this PC is being controlled).
      if (!(info.flags & LLKHF_INJECTED) && CODES[info.vkCode] && shouldCapture(info.vkCode, info.flags, isUp)) {
        if (isUp) captured.delete(info.vkCode);
        else captured.add(info.vkCode);
        if (onKey) onKey(CODES[info.vkCode], !isUp);
        return 1;
      }
    } catch {
      /* fall through to the next hook */
    }
  }
  return CallNextHookEx(hook, nCode, wParam, lParam);
}

// Start capturing; handler(code, down) receives each swallowed key.
function start(handler) {
  onKey = handler;
  if (hook) return true;
  callback = koffi.register(proc, koffi.pointer(LowLevelKeyboardProc));
  hook = SetWindowsHookExW(WH_KEYBOARD_LL, callback, GetModuleHandleW(null), 0);
  if (!hook) {
    koffi.unregister(callback);
    callback = null;
    return false;
  }
  return true;
}

// Stop capturing. Keys still held are reported as released so nothing stays stuck remotely.
function stop() {
  if (onKey) for (const vk of captured) onKey(CODES[vk], false);
  captured.clear();
  if (hook) UnhookWindowsHookEx(hook);
  if (callback) koffi.unregister(callback);
  hook = null;
  callback = null;
  onKey = null;
}

module.exports = { start, stop };
