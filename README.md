# TTCO Plus: Transparent Twitch Chat Overlay

Show your Twitch chat, or any web widget, **on top of your game**. Overlays are transparent and click-through, and they
fade away when you hover over them or press a hotkey. You can keep as many overlays as you like and switch between them.

Built for single-monitor streamers and players who want to see chat while playing a **borderless or windowed** game.
A modern take on [baffler/Transparent-Twitch-Chat-Overlay](https://github.com/baffler/Transparent-Twitch-Chat-Overlay),
rebuilt with [Tauri 2](https://tauri.app) and Microsoft WebView2. It's small and fast and uses little memory.

## Install

1. Download **`TTCO.Plus_x.y.z_x64-setup.exe`** from the [Releases](../../releases) page.
2. Run it and choose **Just for me** or **All users**, then pick **any install folder**.
3. Start **TTCO Plus** from the Start menu, type your Twitch channel name, and you're done.

> Windows may show *"Windows protected your PC"* because the installer isn't code-signed. Click **More info → Run
> anyway**. You can also build it yourself from source (see below).

Requirements: Windows 10 or 11 (64-bit). If the WebView2 runtime is missing, the installer downloads it automatically;
Windows 11 already includes it.

**Where settings are stored:** `config.json` in a `data` folder next to the app, so the whole install stays in one
folder. If the install folder isn't writable (for example *All users* in `Program Files`), settings go to
`%APPDATA%\com.ttcoplus.overlay` instead. Uninstalling keeps your settings unless you tick *Delete the application data*.

## Features

**Fade**
* **Fade now hotkey** (default **Ctrl+Alt+H**): every overlay fades to its *Fade to* level (default 12%) immediately.
  Press it again to restore.
* **Fade on hover**: when your mouse is over a locked overlay, it fades so you can see and click whatever is underneath.
  You can set the delay, speed and how long it stays faded. Turn hover fading on or off everywhere with
  **Ctrl+Alt+Shift+H**.
* *Ignore when the cursor is hidden*: games that capture the mouse (shooters and the like) don't make the chat flicker.

**Many overlays, hide instead of delete**
* Keep different chats, styles and widgets side by side. Hidden overlays keep all their settings and use no resources.
* **Duplicate** an overlay to try a new style without touching the original. Drag overlays between *On screen* and
  *Hidden*.
* **Hide all** (**Ctrl+Alt+V**), and a **Trash** that lets you undo deletes.
* **Layouts**: save which overlays are on screen and where, then switch with one click or **Ctrl+Alt+L**.

**Built-in Twitch chat**
* Anonymous connection (no login). Merge several channels into one overlay.
* 7TV, BTTV and FFZ emotes (including zero-width), badges, and recent history when the overlay opens.
* Sub, raid and announcement notices, first-time-chatter tag, highlight words with an optional sound, and filters for
  bots, !commands, users and words.
* Seven style presets plus full control over fonts (system or Google Fonts), outline, bubbles, panels, spacing, emote
  size, direction, alignment, animation and custom CSS, all with a **live preview**.

**Web widgets**
* Any URL works: StreamElements or Streamlabs widgets, jChat, alerts, viewer counters.
* **Local HTML widgets** work too: paste a `file:///…` link or a `C:\…` path.

**Edit mode** (**Ctrl+Alt+U**)
* Unlock overlays to drag and resize them. Lock them again to make them click-through. Overlays never steal focus from
  your game.

**Tray app**
* Click the **TTCO+ logo** (top-left) any time for the Home page: quick-add a chat and see the tips.
* Closing the manager frees its memory while overlays keep running. Reopen it with **Ctrl+Alt+O** or the tray icon.

All shortcuts can be changed in **Settings**. If another app already uses one, Settings tells you.

## Notes

* Games in **exclusive fullscreen** draw over everything. Use *borderless* or *windowed* mode.
* Some sites (twitch.tv itself, for example) refuse to load inside a web-widget overlay.
* Network services used: Twitch IRC (chat), recent-messages.robotty.de (history), api.ivr.fi (badges), 7tv.io,
  betterttv.net and frankerfacez.com (emotes), and Google Fonts if you pick one.

## Build from source

You need [Node.js](https://nodejs.org) 18+ and [Rust](https://rustup.rs) (stable, MSVC toolchain).

| Command | What it does |
| --- | --- |
| `npm ci` | install the Tauri CLI |
| `npm run dev` | run the app in development mode |
| `npm run build` | build the installer → `src-tauri/target/release/bundle/nsis/` |
| `npm run build:exe` | build only the portable exe → `src-tauri/target/release/ttco-plus.exe` |

Pushing a tag like `v1.0.1` runs [the release workflow](.github/workflows/release.yml), which builds the installer
and attaches it to a draft GitHub Release.

### Project layout

```
src/                 frontend (plain HTML/CSS/JS modules, no build step)
  manager.*          control panel
  overlay.*          overlay window + live preview renderer
  twitch.js          IRC-over-WebSocket client, chat history
  emotes.js          7TV / BTTV / FFZ emotes, badges
  shared.js          overlay schema, defaults, presets
src-tauri/src/
  lib.rs             commands, app setup, window events
  ops.rs             overlay / layout / toggle operations
  windows.rs         window creation, sync, geometry
  hover.rs           cursor polling for hover fade
  shortcuts.rs       global hotkeys
  tray.rs            tray icon + menu
  localfile.rs       loopback server for local HTML widgets
  config.rs          config.json persistence
src-tauri/installer-hooks.nsh   extra uninstall step (optional data removal)
```

## Security

See [SECURITY.md](SECURITY.md). In short: widgets are sandboxed and can't control the app, local files are only served
from folders you chose, and nothing needs a login.

## License

[GPL-3.0-or-later](LICENSE), the same license as the original project. Thanks to
[baffler](https://github.com/baffler) for the original Transparent Twitch Chat Overlay.
