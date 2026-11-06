# Browser Shell

A Chrome-like desktop browser shell built with **Electron**, using the modern
view architecture (`BaseWindow` + `WebContentsView`) instead of the deprecated
`BrowserView` or the discouraged `<webview>` tag.

Every tab is a real Chromium `webContents` in its own renderer process — not an
`iframe`. That means arbitrary sites load (no `X-Frame-Options` / CSP walls),
each tab has a full browser context, and `window.open` popups (OAuth, payments)
behave the way they do in Chrome.

![Tab strip and omnibox](docs/screenshot-tabs.png)

![New tab page](docs/screenshot-newtab.png)

## What's in the box

| Feature | Status |
| --- | --- |
| Tab strip with favicon, title, loading spinner, close button, middle-click close | ✅ |
| Omnibox: URLs, bare domains, `localhost:3000`, IPs, or search (DuckDuckGo) | ✅ |
| Back / forward / reload-stop, live sync with the page | ✅ |
| Real browser tabs (independent renderer per tab, kept alive when switching) | ✅ |
| Shared persistent session — logins and cookies carry across tabs and windows | ✅ |
| `target=_blank` opens a tab; `window.open` popups get a native window sharing the same session (OAuth works) | ✅ |
| Native context menu (open link in new tab, copy link, back/forward, inspect element) | ✅ |
| Keyboard shortcuts: `⌘/Ctrl+T`, `⌘/Ctrl+W`, `⌘/Ctrl+L`, `⌘/Ctrl+R`, `⌘/Ctrl+Shift+R`, `⌘/Ctrl+←/→`, `Ctrl+Tab` | ✅ |
| Session restore: open tabs come back on the next launch | ✅ |
| Chrome extension host: load unpacked folders and `.crx` files, enable/disable/remove, persisted across launches | ✅ |
| Extension content scripts, MV2 background pages, `chrome.storage`, runtime messaging, popups | ✅ |
| Extension toolbar icons + popup window (`chrome-extension://…` in its own window) | ✅ |
| Extensions manager page (`⌘/Ctrl+Shift+E`) with a per-permission capability report | ✅ |
| Automatic tab sleep: releases background renderers, restores URL + scroll on wake | ✅ |
| Per-tab "keep this tab awake" override, persisted per site | ✅ |
| Frameless shell chrome: macOS traffic lights inset, Windows/Linux `titleBarOverlay` | ✅ |
| Headless smoke test that drives the app and writes screenshots | ✅ |

## Requirements

- Node.js ≥ 20 (tested on Node 26 / Electron 45)
- macOS 12+, Windows 10+, or a modern Linux desktop

## Prebuilt demo (macOS arm64)

Grab the zip from [Releases](https://github.com/zccz14/electron-browser-shell/releases/tag/v0.1.0),
unzip, and open `Browser Shell.app` — no Node.js needed. The build is ad-hoc signed
(not notarised), so if a browser set the quarantine flag:

```bash
xattr -dr com.apple.quarantine "/Applications/Browser Shell.app"
```

## Run it

```bash
git clone https://github.com/zccz14/electron-browser-shell.git
cd electron-browser-shell
npm install
npm start
```

### If the Electron binary download stalls

`npm install` fetches the Electron binary from GitHub releases. On a slow or
restricted network, point npm at a mirror first:

```bash
export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
npm install
```

(or put `electron_mirror=https://npmmirror.com/mirrors/electron/` in `~/.npmrc`)

## Build a .app yourself

```bash
npm install
./scripts/package-mac.sh      # -> dist/Browser Shell.app (ad-hoc signed)
```

## Smoke test

Runs the real app against a throwaway profile, opens tabs, navigates, goes back,
closes a tab, resizes the window, **installs an extension (unpacked and from a
`.crx`), asserts its content script really ran in the page and its popup renders**,
and writes PNG screenshots — no display required:

```bash
npx electron . --smoke --smoke-out=/tmp/browser-shell-smoke
```

Exit code `0` means every assertion passed. Artefacts land in the output dir:

```
01-new-tab.png      shell UI, new tab page
02-tabs.png         three tabs, real titles + favicons
03-active-tab.png   the active tab's page
04-after-back.png   after back navigation
05-omnibox.png      after typing in the omnibox
06-resized.png      after window resize
07-extensions.png    the extensions manager page
08-popup.png         an extension popup rendered on chrome-extension://
09-sleeping-tabs.png two sleeps tabs, moon icons in the tab strip
report.json         full state dumps + failures
```

## Tab sleep (the memory story)

A tab is a full Chromium renderer. Detaching its view when you switch tabs keeps
it instant, but it keeps the memory too. Measured on an M-series Mac with this
build: **3 tabs = 790 MB and 6 renderer processes; after the two background tabs
slept = 492 MB and 4 renderers — 298 MB returned.** Light pages cost ~90 MB each,
heavy web apps 250–400 MB.

So the shell sleeps tabs: the policy picks background tabs and **destroys their
renderer**, keeping only `{url, title, favicon, scrollY}`. Waking rebuilds the
view, reloads the URL and puts the scroll position back — the same trade Chrome
makes when it discards a tab.

![Sleeping tabs](docs/screenshot-sleeping-tabs.png)

**The app decides by default, you keep the veto.**

- Idle rule — a background tab older than `--tab-suspend-after-ms` (default 15 min) may be released
- Pressure rule — if the shell's tabs use more than `--memory-limit-mb` (default 1500), the
  least-recently-used background tabs are released until it's back under
- Never released — the active tab, tabs playing audio, internal pages, and any tab
  you marked **Keep this tab awake** (right-click a tab, or `⌘⇧S` to sleep everything now)
- The keep-awake switch is stored per **origin**, so the editor you're working in
  stays awake across restarts

```bash
# try the policy quickly
npx electron . --tab-suspend-after-ms=5000 --policy-tick-ms=2000
```

## Passkeys / WebAuthn

Passkeys do not work in this shell on macOS, and **this is not a bug in the
shell** — it is an Apple gate. The smoke test records the facts on every run:

| Check | Result on macOS |
| --- | --- |
| `window.PublicKeyCredential` present | ✅ |
| secure context | ✅ |
| `navigator.credentials.create` present | ✅ |
| `isUserVerifyingPlatformAuthenticatorAvailable()` | ❌ **false** |
| `create()` with a CDP virtual authenticator | ✅ `ok` |

So the WebAuthn plumbing is intact; what is missing is the **platform
authenticator** (Touch ID / iCloud Keychain). Chromium only exposes it to apps
that hold Apple's
[`com.apple.developer.web-browser.public-key-credential`](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.developer.web-browser.public-key-credential)
entitlement — which requires the Account Holder role of an Apple Developer
account, a review form, and meeting Apple's "this really is a browser" criteria.
Electron cannot ship with it, so every Electron-based browser hits this wall.

What this repo *does* fix:

- **Bluetooth / camera / microphone usage strings** are now written into the
  packaged `Info.plist` (`scripts/package-mac.sh`). Without them macOS refuses the
  BLE transport that cross-device passkeys use — Chromium logs
  *"Cannot use Bluetooth because the responsible app ... does not have Bluetooth
  metadata in its Info.plist"* — and the app is killed the moment a site asks for
  the camera.
- **The diagnostic is permanent**: `webauthn` is a step in the smoke report, so if
  Electron ever ships platform-authenticator support you will see the flag flip.

Paths that remain open: external FIDO2 security keys (USB/NFC), and — if you only
need passkeys for **your own** domain — the `associated-domains` + AASA route used
by Electron apps that are not general-purpose browsers.

## Chrome extensions

`⌘/Ctrl+Shift+E` opens the extensions page — load an unpacked folder or a `.crx`
file, toggle extensions, see what each one will and will not get.

![Extensions page](docs/screenshot-extensions.png)

Electron implements **a subset** of the Chrome extension API and says so plainly:
arbitrary Web Store extensions are out of scope, and `.crx` files are not loadable
as-is. This shell closes the practical gap where it can:

- **`.crx` install** — the CRX3/CRX2 envelope is stripped, the zip unpacked into
  the shell's own folder, then loaded. (Chrome itself refuses to unpack for you.)
- **`.crx` never touches the network** — nothing is fetched from the Web Store;
  you bring the file, the shell does the rest.
- **Popups** — Electron does not implement `chrome.action`, so this shell renders
  the manifest's `default_popup` in a small window on the extension's own
  `chrome-extension://` origin. `chrome.storage` and background messaging work
  there, so most popups are usable.
- **Capability report** — every extension card lists the permissions Electron
  cannot honour, so "installs but does nothing" is visible up front.

### What actually works (verified by the smoke test)

| Area | Status |
| --- | --- |
| Content scripts (`matches`, `run_at`, all frames) | ✅ |
| MV2 background page / event page | ✅ |
| `chrome.storage.local` / `.sync` (local disk, no device sync) | ✅ |
| `chrome.runtime.sendMessage` / `connect` / `onMessage` / `onInstalled` | ✅ |
| `chrome.tabs.sendMessage`, `reload`, `executeScript` (partial `query`) | ✅ |
| `chrome.scripting`, `chrome.i18n`, `chrome.management` (partial) | ✅ |
| DevTools extensions — full API incl. panels | ✅ |
| `chrome.webRequest` — observational only | ⚠️ |
| MV3 `background.service_worker` | ❌ loads as an inert page |
| Blocking `webRequest` / `declarativeNetRequest` | ❌ no real ad blocking |
| `chrome.action` / `browser_action` (native toolbar popup) | ⚠️ emulated in a window |
| `chrome.windows`, `bookmarks`, `history`, `downloads`, `cookies`, `notifications`, `alarms` | ❌ |
| `sidePanel`, `omnibox`, `contextMenus`, `tabGroups` | ❌ |
| Direct install from the Web Store | ❌ bring a `.crx` or an unpacked folder |

Manifest V2 is the version Electron implements best; Chromium warns that MV2 is
deprecated, and you will see that warning in the terminal — it is expected.

Try it with the bundled example:

```bash
# extensions page → Load unpacked → examples/sample-extension
```

## Architecture

```
src/
├── main/
│   ├── index.js     app lifecycle, BaseWindow, chrome view, IPC
│   ├── tabs.js      TabManager — one WebContentsView per tab
│   ├── menu.js      app menu (the accelerators are the shell's shortcuts)
│   ├── urls.js      omnibox input → URL / search
│   └── smoke.js     self-check + screenshots
│   ├── extensions.js ExtensionHost — install / enable / uninstall
│   └── crx.js       .crx (CRX3/CRX2) → unpacked directory
├── preload/
│   ├── chrome.js    contextBridge: the only shell ⇄ main surface
│   └── extensions.js  bridge for the extensions page
├── renderer/
│   ├── index.html   tab strip + toolbar (this *is* the browser UI)
│   ├── styles.css
│   ├── app.js
│   ├── extensions.* the extensions manager page
│   └── newtab.html  local new tab page (works offline)
└── examples/
    └── sample-extension/  MV2 extension used by the smoke test
```

Two layers, and that is the whole trick:

1. **The shell UI** is an ordinary web page in its own `WebContentsView`, pinned
   to the top of the window (`CHROME_HEIGHT = 88px`). Because it is your DOM,
   it can look exactly like Chrome — rounded tabs, hover states, whatever.
2. **The page area** is a stack of `WebContentsView`s, one per tab, laid out
   below the chrome with `setBounds()`. Switching tabs re-attaches a view
   instead of reloading it, so background tabs keep their state.

IPC is deliberately small: the chrome page calls
`shell.newTab() / navigate() / activateTab() / …`, and the main process pushes
the whole tab list back on every change (`shell:state`).

## Platform notes

**macOS** — `titleBarStyle: 'hiddenInset'` with `trafficLightPosition`, so the
traffic lights sit inside the tab strip. The tab strip starts at 84px so it
never collides with them. Primary target, tested on macOS 26 (Apple silicon).

**Windows** — `titleBarStyle: 'hidden'` + `titleBarOverlay`, so the native
minimise/maximise/close buttons are drawn over the shell UI; the tab strip
reserves 148px on the right for them. Not yet run on a Windows box in this
repo's smoke test — PRs welcome.

**Linux** — same code path as Windows (overlay title bar). Needs a desktop with
a compositor; `WebContentsView` positioning is done by Electron, so it is not
tied to any toolkit-specific layout.

## Known limits (v0.3)

- The shell UI is only 88px tall, so autocomplete dropdowns that would overlap
  the page are not implemented yet. The `⋯` button opens a native menu instead.
- Tabs are not draggable for reordering.
- A sleeping tab loses form state and page state (only URL + scroll come back) —
  mark tabs you are typing in as "keep awake", or the idle rule may release them.
- Platform passkeys (Touch ID / iCloud Keychain) are unavailable on macOS; see above.
- No bookmarks, no history page, no downloads UI, no per-site zoom.
- Session restore keeps `http(s)` URLs only.
- Extensions can't be installed from the Web Store in one click, and MV3
  service-worker backgrounds don't run.
- No memory-pressure signal from the OS is consumed yet; the policy is timer +
  own accounting.

## License

MIT
