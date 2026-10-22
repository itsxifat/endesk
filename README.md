# EnDesk

A cross-platform **remote desktop** app (AnyDesk-style) for **Windows** and **macOS**.
Control one computer fully from another — keyboard, mouse, and live screen —
including **Windows ↔ Mac** in either direction.

- **Live screen** streamed peer-to-peer over **WebRTC** (direct device-to-device).
- **Full input control**: mouse move/click/drag/scroll and keyboard, injected
  natively on the controlled machine via `robotjs`.
- **AnyDesk-style pairing**: every device shows a 9-digit **ID** + a **password**.
  Enter them on the other device to connect.
- **Attended or unattended**: approve each session, or set a permanent password
  for always-on access.
- A small **signaling relay** only brokers the connection; it never sees your
  screen, input, or password.

> ⚠️ **Use responsibly.** Only connect to machines you own or are explicitly
> authorized to access. Remote control of a computer without the owner's
> informed consent is illegal in most places.

---

## How it works

```
  Viewer (controls)                 Relay (signaling only)              Host (shared screen)
  ┌───────────────┐   ws/wss   ┌───────────────────────┐   ws/wss   ┌───────────────────┐
  │  Electron app │◄──────────►│  find peer by ID,     │◄──────────►│   Electron app    │
  │  shows video, │            │  pass SDP/ICE,        │            │  desktopCapturer, │
  │  sends input  │            │  accept/reject        │            │  robotjs inject   │
  └──────┬────────┘            └───────────────────────┘            └─────────┬─────────┘
         │                                                                    │
         │        WebRTC: H.264/VP8 video  +  DataChannel (input)             │
         └────────────────────────── direct P2P ─────────────────────────────┘
```

- The **host** captures its screen with Electron's `desktopCapturer` and sends
  the video track to the viewer. It receives input events on a WebRTC data
  channel and replays them with `robotjs`.
- The **viewer** shows the video and forwards mouse/keyboard events (as
  normalized coordinates, so it works across any resolution/DPI mismatch).
- The **relay** only exchanges the connection handshake. Media and input go
  **directly** between the two devices.

---

## Project layout

```
endesk/
├─ package.json            # Electron app + electron-builder config (win + mac)
├─ build/
│  └─ entitlements.mac.plist
├─ src/
│  ├─ main.js              # Electron main: capture sources, robotjs injection, config
│  ├─ preload.js           # secure contextBridge API
│  └─ renderer/
│     ├─ index.html        # UI
│     ├─ style.css
│     ├─ keymap.js         # browser key codes -> robotjs key names
│     └─ app.js            # signaling client + WebRTC + input capture
└─ server/
   ├─ package.json
   └─ relay.js             # WebSocket signaling relay
```

---

## 1. Run the relay server

The relay must be reachable by **both** devices. For two machines on the same
LAN you can run it on either one. For internet use, run it on a small VPS and
put TLS (`wss://`) in front of it.

```bash
cd server
npm install
PORT=8080 npm start
# -> EnDesk relay listening on ws://0.0.0.0:8080
```

Health check: `http://<relay-host>:8080/health`

> For `wss://`, terminate TLS with nginx/Caddy and proxy to `localhost:8080`.

---

## 2. Run the app (development)

On **each** computer you want to use:

```bash
npm install          # installs Electron + robotjs (prebuilt native binary)
npm start
```

Then in the app:

1. Open **Settings** and set the **relay URL** to the same server on both
   devices (e.g. `ws://192.168.1.50:8080` or `wss://relay.example.com`), **Save**.
2. On the device you want to **control** (the host): note its **ID** and
   **password** on the *This device* screen.
3. On the other device (the viewer): go to **Connect**, enter that ID and
   password, and press **Connect**.
4. The host either auto-accepts (if *unattended* is on) or shows an **Accept**
   prompt. Once accepted, the viewer sees and controls the remote screen.

---

## 3. Build installers

```bash
# Windows (.exe NSIS installer + portable) — build on Windows
npm run dist:win

# macOS (universal .dmg, Intel + Apple Silicon) — build on macOS
npm run dist:mac
```

Output lands in `dist/`.

- The `robotjs` native module ships as a **prebuilt N-API binary** (universal
  on macOS, x64 on Windows), so no C++ toolchain is needed to package.
- macOS release builds should be **code-signed and notarized** for Gatekeeper;
  add your signing identity to the `mac` block / env vars for electron-builder.

---

## macOS permissions (required to be *controlled*)

macOS gates screen capture and input injection. On the Mac that will be
controlled, grant both (the app has buttons that open the right panes):

- **System Settings → Privacy & Security → Screen Recording → EnDesk**
- **System Settings → Privacy & Security → Accessibility → EnDesk**

Relaunch EnDesk after granting. A Mac acting only as the **viewer** needs
neither permission.

On **Windows** no special permission is needed for normal desktop control.
(The secure "Ctrl+Alt+Del" / UAC screen can't be driven by a normal app — that
button is best-effort for in-session dialogs.)

---

## Controls (viewer toolbar)

- **Control** — toggle sending input (off = view only).
- **Fit** — scale the remote screen to the window, or show it 1:1 (scrollable).
- **Swap ⌘/Ctrl** — map the Mac ⌘ key to Windows Ctrl (and back) for natural
  shortcuts across platforms.
- **Ctrl+Alt+Del** — send the combo to a Windows host.
- **Disconnect** — end the session.

---

## Security notes

- The relay never receives the password; the **host app** verifies it.
- Passwords are random per session unless you set a permanent one in Settings.
- Media and input are end-to-end between the two peers (DTLS/SRTP via WebRTC).
- On very restrictive networks (symmetric NAT) a **TURN** server may be needed;
  add its credentials to the `ICE` list in `src/renderer/app.js`.

---

## License

MIT
