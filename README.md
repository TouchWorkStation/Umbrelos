# UmbrelOS Touch

A phone-first interface for umbrelOS. It runs beside your Umbrel, signs in the same way Umbrel's own iPhone and Mac apps do, and controls your real apps, machines and system. It never modifies the Umbrel.

| Home | App actions | App Store | System |
| --- | --- | --- | --- |
| ![Home](docs/home.png) | ![App actions](docs/app-sheet.png) | ![App Store](docs/store.png) | ![System](docs/system.png) |

## Look and feel

- **Your umbrelOS wallpaper.** It's loaded from your own Umbrel. The accent color matches the wallpaper's brand color, just like umbrelOS.
- **Frosted glass** cards, sheets and a floating dock with a sliding indicator.
- **Tabler icons**, the same open-source icon family umbrelOS uses. **Inter** is bundled locally, so nothing loads from a CDN.
- **Touch-first details:** bottom sheets you can swipe down to close, spring animations, a light vibration on Android, and tap targets of at least 44 px. It respects Reduce Motion.
- **Other themes:** Catppuccin, Tokyo Night, Gruvbox and Latte (light), plus seven accent colors.

## What works

- **Home**: live CPU, memory and storage rings, temperature and uptime, app updates, recently opened apps, and an app grid. Stopped apps are dimmed, apps with updates get a badge, and busy apps show a progress ring.
- **Apps**: search and filters. Tap an app to open it, start, stop, restart, update, view live logs, or uninstall (with confirmation). There is also *Update all*.
- **App Store**: featured apps with screenshots, a shelf for each category, and search. Get and Open buttons sit on every app. App pages show the version, category, size, gallery and description. Install is guided: it lists the folders and GPU access the app will get, and blocks the install until missing dependencies are installed.
- **Machines**: your VMs with their live state. Start, shut down, restart, force stop (with confirmation), and a full-screen touch **console**.
- **System**: live CPU and memory charts, temperature, uptime, a storage breakdown, a ranked "what's using it" list for CPU, memory and storage, umbrelOS update status, and restart or shut down the Umbrel.
- **Notifications**: a bell with a count, and a sheet where you can dismiss each one.
- **PWA**: add it to your Home Screen to run full screen.

## How it connects (and why it's safe)

```
Phone ──(cookie)──> UmbrelOS Touch server ──(Bearer, native session)──> umbreld /trpc
```

- umbreld's browser login ties its token to an HttpOnly cookie on umbreld's own address and sends no CORS headers, so a separate web page can't call it directly. umbreld also has a **native login** (`user.loginNative`, added in umbrelOS 2.0) that issues a 1-hour access token plus a device token for renewing it. UmbrelOS Touch uses that.
- Those credentials stay on the Touch server, in a 0600 file. Your phone only gets an opaque `HttpOnly; SameSite=Strict` cookie.
- Each phone that signs in becomes its own session in umbrelOS. If you revoke it there, that phone is signed out.
- Only an **allowlist** of 35 umbreld procedures can be reached (see `ALLOWED` in `server/app.mjs`). Factory reset, password changes, network settings and app-store repositories are refused before they reach the Umbrel.
- Every action that changes something has to come from the app's own page (custom header plus Origin check). Sign-in is rate-limited.
- No Docker socket, no SSH, no changes to umbrelOS files.
- umbrelOS before 2.0 has no native login. For those versions it falls back to `user.login` bearer tokens.

## Install

**On your Umbrel (recommended).** Open umbrelOS, go to **Settings > Advanced settings > Terminal**, and paste:

```bash
curl -fsSL https://raw.githubusercontent.com/TouchWorkStation/Umbrelos/main/install.sh | sudo bash
```

It builds a small Docker image, starts one container named `umbrel-touch`, and prints the address to open on your phone (`http://<umbrel-ip>:7780`). Sign in with your umbrelOS password, then **Share > Add to Home Screen**.

- Nothing in umbrelOS is modified. The container talks to umbrelOS over `127.0.0.1`, the same API the dashboard uses.
- It restarts on boot. Docker's data lives on umbrelOS's data partition, so it is expected to survive umbrelOS updates.
- **Update:** run the same command again. **Remove:** add `-s -- uninstall` after `bash`.
- **Different port:** `... | sudo TOUCH_PORT=7790 bash`

**On another Linux machine with Docker** (a NAS, a Pi): the same command, with your Umbrel's address:

```bash
curl -fsSL https://raw.githubusercontent.com/TouchWorkStation/Umbrelos/main/install.sh | sudo UMBREL_URL=192.168.1.50 bash
```

**Windows:** install Node.js 20+ and double-click `start-windows.cmd`. **By hand:** `npm ci && npm run build && node server/cli.mjs --umbrel 192.168.1.50`.

## VM console

Machines > a running machine > **Open console** gives you the VM's screen full-screen on your phone: tap to click, drag to drag, long-press or two-finger tap to right-click, and drag with two fingers to scroll. The keyboard button opens the phone keyboard, and a key row adds esc, tab, ctrl, alt, arrows, super and ctrl+alt+del.

umbreld only gives console tickets to browser sessions, not to the native sessions used for everything else. So at sign-in the Touch server also opens one browser-style session and keeps it server-side, used only to fetch a 30-second, single-use ticket each time a console opens. The VNC stream is then bridged phone <-> Touch server <-> umbreld. The bridge refuses connections from other sites and from signed-out phones.

## Develop

```bash
npm test                          # server tests against a test-only umbreld stand-in
node test/fake-umbreld.mjs 7781   # TEST ONLY fake, password "correct horse"
node server/cli.mjs --umbrel 127.0.0.1:7781 --data /tmp/touch &
npm run dev                       # Vite on :5173, proxies /api to :7780
```

The procedure names and data shapes come from getumbrel/umbrel at the umbrelOS 2.0 release (`9298257b`) and were checked against `master` (2.1 Beta 1).

## Not yet

- Files and Photos. umbreld serves these through separate `/api/files` endpoints, which haven't been wired in yet.
- VM audio and the umbrelOS terminal.
- Settings that change the system (users, Wi-Fi, backups). These are deliberately left out of the allowlist for now.

## License

UmbrelOS Touch's own code is MIT. It contains no umbrelOS source code. It talks to umbrelOS (PolyForm Noncommercial 1.0.0) over its API. Not affiliated with Umbrel.
