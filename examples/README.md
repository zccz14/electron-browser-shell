# Example extensions

**`sample-extension/`** — a Manifest V2 extension used by the smoke test. It proves
the parts of the Chrome extension surface that Electron really implements:

- a content script injected into every `http(s)` page (`content.js`)
- `chrome.storage.local` reads and writes
- an event-page background script answering `chrome.runtime.sendMessage`
- a `browser_action` popup (this shell opens it in a window, see below)

Load it in the running app with `⌘/Ctrl+Shift+E` → **Load unpacked** → pick this
folder, then open any website: a blue banner appears bottom-left and the count
goes up on every page.

## Try it from the terminal

```bash
npx electron . --smoke --smoke-out=/tmp/browser-shell-smoke
```

The smoke test installs this extension, loads a page, and asserts that the
banner element exists in the page's DOM — i.e. that content scripts, storage and
messaging actually work, not just that the extension "loaded".
