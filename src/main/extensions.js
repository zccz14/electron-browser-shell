'use strict'

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { unpackCrx } = require('./crx')

// What Electron actually implements of the chrome.* surface (docs: api/extensions.md).
const SUPPORTED = [
  'storage.local', 'runtime.sendMessage', 'runtime.connect', 'runtime.onMessage',
  'runtime.getManifest', 'runtime.getURL', 'runtime.reload', 'tabs.sendMessage',
  'tabs.executeScript', 'tabs.query (partial)', 'tabs.reload', 'scripting',
  'webRequest (observational)', 'devtools.*', 'i18n', 'management (partial)'
]

// Permissions that no Electron app can honour today. Reported per extension so
// the user knows why an extension "installs but does nothing".
const UNSUPPORTED = {
  bookmarks: 'chrome.bookmarks is not implemented',
  history: 'chrome.history is not implemented',
  downloads: 'chrome.downloads is not implemented',
  cookies: 'chrome.cookies is not implemented',
  notifications: 'chrome.notifications is not implemented',
  webRequestBlocking: 'blocking webRequest is not implemented (ad blockers will not block)',
  declarativeNetRequest: 'declarativeNetRequest is not implemented (MV3 ad blockers will not block)',
  sidePanel: 'chrome.sidePanel is not implemented',
  omnibox: 'chrome.omnibox is not implemented',
  contextMenus: 'chrome.contextMenus is not implemented',
  windows: 'chrome.windows is not implemented',
  tabGroups: 'chrome.tabGroups is not implemented',
  alarms: 'chrome.alarms is not implemented'
}

function readManifest (dir) {
  const raw = fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')
  return JSON.parse(raw)
}

function iconDataUrl (dir, manifest) {
  const icons = manifest.icons || (manifest.browser_action && manifest.browser_action.default_icon) ||
    (manifest.action && manifest.action.default_icon)
  let rel = null
  if (typeof icons === 'string') rel = icons
  else if (icons && typeof icons === 'object') {
    const sizes = Object.keys(icons).map(Number).sort((a, b) => b - a)
    for (const size of [48, 32, 128, 16, sizes[0]]) {
      if (size != null && icons[String(size)]) { rel = icons[String(size)]; break }
    }
  }
  if (!rel) return null
  const file = path.join(dir, rel)
  try {
    const buf = fs.readFileSync(file)
    const mime = file.endsWith('.svg') ? 'image/svg+xml' : 'image/png'
    return `data:${mime};base64,${buf.toString('base64')}`
  } catch (_) {
    return null
  }
}

function warningsFor (manifest) {
  const warnings = []
  const perms = [...(manifest.permissions || []), ...(manifest.optional_permissions || [])]
  for (const perm of perms) {
    if (UNSUPPORTED[perm]) warnings.push(UNSUPPORTED[perm])
  }
  if (manifest.manifest_version === 3) {
    const bg = manifest.background
    if (bg && bg.service_worker) warnings.push('MV3 service-worker background is not supported (loads as an inert page)')
    if (manifest.host_permissions && manifest.host_permissions.length) {
      // host permissions are honoured for content scripts
    }
  }
  if (manifest.devtools_page) warnings.push('DevTools extension: open DevTools to use its panel')
  return warnings
}

/**
 * Owns the extension lifecycle: install (unpacked folder or .crx), enable /
 * disable, uninstall, and (re)loading them into the shell's persistent session.
 */
class ExtensionHost {
  constructor ({ session, userDataDir }) {
    this.session = session
    this.dir = path.join(userDataDir, 'shell-extensions')
    this.registryFile = path.join(this.dir, 'registry.json')
    this.entries = []      // [{ path, source, enabled, id }]
    this.loaded = new Map() // id -> { id, manifest, dir, entry }
  }

  // ------------------------------------------------------------- persistence
  readRegistry () {
    try {
      const data = JSON.parse(fs.readFileSync(this.registryFile, 'utf8'))
      if (Array.isArray(data.entries)) this.entries = data.entries
    } catch (_) { this.entries = [] }
  }

  writeRegistry () {
    fs.mkdirSync(this.dir, { recursive: true })
    fs.writeFileSync(this.registryFile, JSON.stringify({ entries: this.entries }, null, 2))
  }

  // ------------------------------------------------------------------ loading
  async loadAll () {
    this.readRegistry()
    for (const entry of this.entries) {
      if (!entry.enabled) continue
      try {
        await this.loadOne(entry)
      } catch (err) {
        entry.error = String(err && err.message ? err.message : err)
      }
    }
    this.writeRegistry()
  }

  async loadOne (entry) {
    if (!fs.existsSync(path.join(entry.path, 'manifest.json'))) {
      throw new Error('manifest.json missing (extension folder was moved or deleted)')
    }
    const ext = await this.session.extensions.loadExtension(entry.path)
    entry.id = ext.id
    entry.error = null
    this.loaded.set(ext.id, { id: ext.id, entry })
    return ext
  }

  async unloadOne (entry) {
    if (!entry.id) return
    try { await this.session.extensions.removeExtension(entry.id) } catch (_) {}
    this.loaded.delete(entry.id)
  }

  // ------------------------------------------------------------------ install
  targetDirFor (name) {
    const slug = String(name || 'extension').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').slice(0, 40) || 'extension'
    const suffix = crypto.randomBytes(4).toString('hex')
    return path.join(this.dir, `${slug}-${suffix}`)
  }

  /** Load unpacked: either copy it into the shell's folder or point at it in place. */
  async installFromDirectory (sourceDir, { copy = true } = {}) {
    const manifest = readManifest(sourceDir)
    let dir = sourceDir
    if (copy) {
      dir = this.targetDirFor(manifest.name)
      fs.mkdirSync(dir, { recursive: true })
      fs.cpSync(sourceDir, dir, { recursive: true })
    }
    const entry = { path: dir, source: copy ? 'unpacked-copy' : 'unpacked', enabled: true }
    await this.loadOne(entry)
    this.entries.push(entry)
    this.writeRegistry()
    return this.describe(entry)
  }

  /** Chrome cannot be asked to install a .crx here, so unpack it and load that. */
  async installFromCrx (crxPath) {
    const dir = this.targetDirFor(path.basename(crxPath, '.crx'))
    unpackCrx(crxPath, dir)
    const entry = { path: dir, source: 'crx', enabled: true }
    await this.loadOne(entry)
    this.entries.push(entry)
    this.writeRegistry()
    return this.describe(entry)
  }

  async setEnabled (id, enabled) {
    const entry = this.entries.find((e) => e.id === id)
    if (!entry) return null
    entry.enabled = enabled
    if (enabled) await this.loadOne(entry).catch((err) => { entry.error = String(err.message || err) })
    else await this.unloadOne(entry)
    this.writeRegistry()
    return this.describe(entry)
  }

  async remove (id) {
    const index = this.entries.findIndex((e) => e.id === id)
    if (index === -1) return false
    const [entry] = this.entries.splice(index, 1)
    await this.unloadOne(entry)
    if (entry.path.startsWith(this.dir + path.sep)) {
      try { fs.rmSync(entry.path, { recursive: true, force: true }) } catch (_) {}
    }
    this.writeRegistry()
    return true
  }

  // ------------------------------------------------------------------ listing
  describe (entry) {
    let manifest = {}
    try { manifest = readManifest(entry.path) } catch (_) {}
    return {
      id: entry.id || null,
      path: entry.path,
      source: entry.source,
      enabled: entry.enabled !== false,
      error: entry.error || null,
      name: manifest.name || path.basename(entry.path),
      version: manifest.version || '0.0.0',
      description: manifest.description || '',
      manifestVersion: manifest.manifest_version || 2,
      permissions: [...(manifest.permissions || []), ...(manifest.host_permissions || [])],
      hasPopup: Boolean((manifest.action && manifest.action.default_popup) ||
                        (manifest.browser_action && manifest.browser_action.default_popup)),
      popupPath: (manifest.action && manifest.action.default_popup) ||
                 (manifest.browser_action && manifest.browser_action.default_popup) || null,
      icon: iconDataUrl(entry.path, manifest),
      warnings: warningsFor(manifest),
      supported: SUPPORTED
    }
  }

  list () {
    return this.entries.map((entry) => this.describe(entry))
  }

  /** chrome-extension://<id>/popup.html — loadable in a window of this session. */
  popupUrl (id) {
    const ext = this.list().find((e) => e.id === id)
    if (!ext || !ext.popupPath) return null
    return `chrome-extension://${id}/${ext.popupPath}`
  }
}

module.exports = { ExtensionHost, SUPPORTED, UNSUPPORTED }
