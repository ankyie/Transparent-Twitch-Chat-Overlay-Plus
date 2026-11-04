# Security

## How TTCO Plus keeps you safe

* **No login, no tokens.** Twitch chat is read anonymously. The app never asks for or stores passwords or OAuth tokens.
* **Web widgets are isolated.** Web-widget overlays run in a sandboxed frame. They can't call the app's internal
  commands, open popups, navigate the overlay away or start downloads. This holds for both remote widgets and local
  HTML files.
* **Local HTML widgets** are served by a small web server that only listens on `127.0.0.1`. To be served, a request
  must:
  * include a random token that changes every time the app starts,
  * use the loopback address as its `Host` (this blocks DNS-rebinding attacks), and
  * ask for a file inside the folder of a widget you added, or one of its subfolders.

  Directory listings, other folders and whole drives are never served, and the server sends no CORS headers.
* **Strict Content-Security-Policy** on the app's own pages: only the app's bundled scripts can run.
* **Chat text is never inserted as HTML**, so a chat message can't inject markup or scripts.
* **Everything stays local.** Settings are stored in `config.json` on your PC. Apart from Twitch, the app only connects
  to the emote, badge and history services listed in the README.

## Reporting a vulnerability

Please open a private [security advisory](../../security/advisories/new) on this repository instead of a public issue.
Include steps to reproduce if you can.
