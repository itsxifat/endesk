'use strict';

// Maps a browser KeyboardEvent.code (physical key position) to a robotjs key
// name. We transmit *physical* keys (scancode-style, like real remote-desktop
// protocols) rather than produced characters: this is layout-robust and avoids
// double-applying modifiers. The host's OS turns the physical key + modifiers
// into the correct character for its own keyboard layout.
const CODE_TO_ROBOT = (() => {
  const m = {};

  // Letters
  for (let c = 65; c <= 90; c++) {
    m['Key' + String.fromCharCode(c)] = String.fromCharCode(c + 32); // KeyA -> 'a'
  }
  // Top-row digits
  for (let d = 0; d <= 9; d++) m['Digit' + d] = String(d);
  // Numpad
  for (let d = 0; d <= 9; d++) m['Numpad' + d] = 'numpad_' + d;
  Object.assign(m, {
    NumpadAdd: 'numpad_+',
    NumpadSubtract: 'numpad_-',
    NumpadMultiply: 'numpad_*',
    NumpadDivide: 'numpad_/',
    NumpadDecimal: 'numpad_.',
    NumpadEnter: 'enter',
    NumLock: 'numpad_lock',
  });
  // Function keys F1..F24
  for (let f = 1; f <= 24; f++) m['F' + f] = 'f' + f;

  Object.assign(m, {
    // Punctuation (sent as the base, unshifted character)
    Minus: '-',
    Equal: '=',
    BracketLeft: '[',
    BracketRight: ']',
    Backslash: '\\',
    Semicolon: ';',
    Quote: "'",
    Backquote: '`',
    Comma: ',',
    Period: '.',
    Slash: '/',
    Space: 'space',

    // Editing / navigation
    Enter: 'enter',
    Tab: 'tab',
    Backspace: 'backspace',
    Delete: 'delete',
    Escape: 'escape',
    Home: 'home',
    End: 'end',
    PageUp: 'pageup',
    PageDown: 'pagedown',
    ArrowUp: 'up',
    ArrowDown: 'down',
    ArrowLeft: 'left',
    ArrowRight: 'right',
    Insert: 'insert',
    CapsLock: 'capslock',
    PrintScreen: 'printscreen',
    ContextMenu: 'menu',

    // Modifiers
    ShiftLeft: 'shift',
    ShiftRight: 'right_shift',
    ControlLeft: 'control',
    ControlRight: 'right_control',
    AltLeft: 'alt',
    AltRight: 'right_alt',
    MetaLeft: 'command',
    MetaRight: 'command',
    OSLeft: 'command',
    OSRight: 'command',
  });

  return m;
})();

const MODIFIER_NAMES = new Set([
  'shift',
  'right_shift',
  'control',
  'right_control',
  'alt',
  'right_alt',
  'command',
]);

// Optional ⌘<->Ctrl swap for Mac<->Windows ergonomics.
function mapCode(code, swapCmdCtrl) {
  let name = CODE_TO_ROBOT[code] || null;
  if (!name) return null;
  if (swapCmdCtrl) {
    if (name === 'command') name = 'control';
    else if (name === 'control') name = 'command';
    else if (name === 'right_control') name = 'command';
  }
  return name;
}

window.EndeskKeymap = { mapCode, MODIFIER_NAMES };
