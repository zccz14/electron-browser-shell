'use strict'

const path = require('node:path')
const { app, WebContentsView, Menu, clipboard, shell } = require('electron')
const { normalizeInput } = require('./urls')

const NEW_TAB_PAGE = path.join(__dirname, '..', 'renderer', 'newtab.html')
const FILE_PREFIX = 'file://'

let nextId = 1

/**
 * One WebContentsView per tab — the same model a real browser uses.
 *
 * Inactive tabs stay alive (like Chrome) until the sleep policy decides to
 * release them: a sleeping tab keeps only its metadata, its renderer process
 * is destroyed and rebuilt on wake. That is exactly what Chrome calls
 * "tab discard", and it is the only way to actually give memory back, since
 * Electron exposes no freeze API.
 */
class TabManager {
  constructor ({ window, session, topInset = 88, onState, policy = {} }) {
    this.window = window
    this.sharedSession = session
    this.topInset = topInset
    this.onState = onState

    this.tabs = new Map()
    this.order = []
    this.activeId = null
    this.viewport = { x: 0, y: topInset, width: 0, height: 0 }
    this.destroying = false

    // --- sleep policy -----------------------------------------------------
    this.policy = {
      idleMs: policy.idleMs ?? 15 * 60 * 1000,      // background tab age before it may be released
      tickMs: policy.tickMs ?? 30 * 1000,
      memoryLimitMB: policy.memoryLimitMB ?? 1500,  // pressure threshold: release LRU tabs above this
      enabled: policy.enabled !== false
    }
    this.keepAliveOrigins = new Set()
    this.lastMemoryMB = null
    this.sleepTimer = null
    this.stats = { suspendedTotal: 0, lastSweepAt: null }
  }

  // ---------------------------------------------------------------- lifecycle
  create ({ url = null, activate = true, preload = null } = {}) {
    const id = nextId++
    const tab = {
      id,
      view: null,
      preload,
      title: '',
      url: '',
      favicon: null,
      loading: false,
      canGoBack: false,
      canGoForward: false,
      isNewTab: !url,
      isInternal: !url,
      error: null,
      keepAlive: false,
      suspended: false,
      suspendedAt: null,
      suspendedReason: null,
      lastActiveAt: Date.now(),
      scrollY: 0,
      memoryMB: null
    }

    this.tabs.set(id, tab)
    this.order.push(id)

    this.attachView(tab)
    if (url) tab.view.webContents.loadURL(url)
    else tab.view.webContents.loadFile(NEW_TAB_PAGE)

    if (activate) this.activate(id)
    this.emit()
    return id
  }

  /** Build (or rebuild, after a sleep) the WebContentsView for a tab. */
  attachView (tab) {
    const view = new WebContentsView({
      webPreferences: {
        session: this.sharedSession,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: true,
        ...(tab.preload ? { preload: tab.preload } : {})
      }
    })
    view.setBackgroundColor('#202124')
    tab.view = view
    tab.suspended = false
    tab.suspendedReason = null
    this.wire(tab)
    return view
  }

  close (id) {
    const tab = this.tabs.get(id)
    if (!tab) return

    const index = this.order.indexOf(id)
    this.order.splice(index, 1)
    this.tabs.delete(id)

    this.detach(tab)
    if (tab.view) {
      try { tab.view.webContents.close() } catch (_) {}
      tab.view = null
    }

    if (this.activeId === id) {
      this.activeId = null
      if (this.destroying) return this.emit()
      const next = this.order[index] || this.order[index - 1] || this.order[0]
      if (next != null) this.activate(next)
      else this.create({})
    }
    this.emit()
  }

  closeActive () {
    if (this.activeId != null) this.close(this.activeId)
  }

  detach (tab) {
    if (!tab.view) return
    try { this.window.contentView.removeChildView(tab.view) } catch (_) {}
  }

  activate (id) {
    const tab = this.tabs.get(id)
    if (!tab || this.destroying) return

    if (tab.suspended) this.wake(id)

    const prev = this.activeId != null ? this.tabs.get(this.activeId) : null
    if (prev && prev.id !== id) {
      this.detach(prev)
      prev.lastActiveAt = Date.now()
    }

    this.activeId = id
    tab.lastActiveAt = Date.now()
    if (tab.view && !this.window.contentView.children.includes(tab.view)) {
      this.window.contentView.addChildView(tab.view)
    }
    if (tab.view) {
      tab.view.setBounds(this.viewport)
      tab.view.webContents.focus()
    }
    this.emit()
  }

  cycle (delta) {
    if (this.order.length < 2) return
    const current = this.order.indexOf(this.activeId)
    const next = (current + delta + this.order.length) % this.order.length
    this.activate(this.order[next])
  }

  layout ({ width, height }) {
    this.viewport = { x: 0, y: this.topInset, width, height: Math.max(0, height) }
    const tab = this.activeId != null ? this.tabs.get(this.activeId) : null
    if (tab && tab.view) tab.view.setBounds(this.viewport)
  }

  destroyAll () {
    this.destroying = true
    this.stopPolicy()
    for (const id of [...this.order]) this.close(id)
  }

  // ------------------------------------------------------------------ sleeping
  canSleep (tab) {
    if (!tab || tab.suspended) return false
    if (tab.id === this.activeId) return false
    if (tab.keepAlive) return false
    if (tab.isInternal || tab.isNewTab) return false
    if (!tab.url) return false
    try {
      if (tab.view && tab.view.webContents.isCurrentlyAudible()) return false
    } catch (_) {}
    return true
  }

  async sleep (id, reason = 'idle') {
    const tab = this.tabs.get(id)
    if (!tab || !this.canSleep(tab)) return false

    const wc = tab.view.webContents
    try {
      tab.scrollY = await wc.executeJavaScript('window.scrollY', true)
    } catch (_) { tab.scrollY = 0 }
    try {
      tab.url = wc.getURL() || tab.url
      tab.title = wc.getTitle() || tab.title
    } catch (_) {}

    const savedMB = tab.memoryMB

    this.detach(tab)
    try { wc.close() } catch (_) {}
    tab.view = null
    tab.suspended = true
    tab.suspendedAt = Date.now()
    tab.suspendedReason = reason
    tab.memoryMB = null
    this.stats.suspendedTotal += 1
    console.log(`[sleep] released tab #${tab.id} (${tab.url}) reason=${reason} freed≈${savedMB || '?'}MB`)
    this.emit()
    return true
  }

  async wake (id) {
    const tab = this.tabs.get(id)
    if (!tab || !tab.suspended) return false

    this.attachView(tab)
    const view = tab.view
    const restore = () => {
      if (tab.scrollY) {
        view.webContents.executeJavaScript(`window.scrollTo(0, ${Math.round(tab.scrollY)})`).catch(() => {})
      }
    }
    view.webContents.once('did-finish-load', restore)
    if (tab.url) view.webContents.loadURL(tab.url).catch(() => {})
    else view.webContents.loadFile(NEW_TAB_PAGE)

    if (this.window.contentView && !this.window.contentView.children.includes(view)) {
      this.window.contentView.addChildView(view)
    }
    view.setBounds(this.viewport)
    console.log(`[sleep] woke tab #${tab.id} (${tab.url})`)
    this.emit()
    return true
  }

  setKeepAlive (id, keepAlive) {
    const tab = this.tabs.get(id)
    if (!tab) return
    tab.keepAlive = Boolean(keepAlive)
    try {
      const origin = tab.url ? new URL(tab.url).origin : null
      if (origin) {
        if (tab.keepAlive) this.keepAliveOrigins.add(origin)
        else this.keepAliveOrigins.delete(origin)
      }
    } catch (_) {}
    this.emit()
  }

  keepAliveFor (url) {
    try {
      return this.keepAliveOrigins.has(new URL(url).origin)
    } catch (_) {
      return false
    }
  }

  // -------------------------------------------------------------- sleep policy
  startPolicy () {
    if (!this.policy.enabled || this.sleepTimer) return
    this.sleepTimer = setInterval(() => { this.sweep().catch(() => {}) }, this.policy.tickMs)
    if (this.sleepTimer.unref) this.sleepTimer.unref()
  }

  stopPolicy () {
    if (this.sleepTimer) clearInterval(this.sleepTimer)
    this.sleepTimer = null
  }

  async measure () {
    // Electron exposes per-process numbers through app.getAppMetrics(); the
    // old webContents.getProcessMemoryInfo() no longer exists. Join on the
    // renderer's OS pid.
    const byPid = new Map()
    for (const metric of app.getAppMetrics()) {
      const kb = metric.memory && metric.memory.workingSetSize
      if (typeof kb === 'number' && metric.pid) byPid.set(metric.pid, Math.round(kb / 1024))
    }

    const live = this.order
      .map((id) => this.tabs.get(id))
      .filter((tab) => tab && tab.view && !tab.suspended)

    let total = 0
    for (const tab of live) {
      try {
        const pid = tab.view.webContents.getOSProcessId()
        tab.memoryMB = byPid.has(pid) ? byPid.get(pid) : null
        if (tab.memoryMB) total += tab.memoryMB
      } catch (_) {
        tab.memoryMB = null
      }
    }
    this.lastMemoryMB = total
    return total
  }

  /** One policy pass: idle tabs first, then LRU eviction under memory pressure. */
  async sweep ({ force = false } = {}) {
    if (!this.policy.enabled && !force) return []
    const slept = []
    const now = Date.now()

    // Measure first so the log, the tab menu and the pressure rule all work
    // off real numbers rather than guesses.
    let total = await this.measure()

    const candidates = this.order
      .map((id) => this.tabs.get(id))
      .filter((tab) => this.canSleep(tab))
      .sort((a, b) => a.lastActiveAt - b.lastActiveAt)

    for (const tab of candidates) {
      if (now - tab.lastActiveAt < this.policy.idleMs) continue
      const freed = tab.memoryMB || 0
      if (await this.sleep(tab.id, 'idle')) {
        slept.push(tab.id)
        total -= freed
      }
    }

    // memory pressure: release oldest background tabs until under the limit
    const remaining = this.order
      .map((id) => this.tabs.get(id))
      .filter((tab) => this.canSleep(tab))
      .sort((a, b) => a.lastActiveAt - b.lastActiveAt)
    for (const tab of remaining) {
      if (total <= this.policy.memoryLimitMB) break
      const freed = tab.memoryMB || 0
      if (await this.sleep(tab.id, 'pressure')) {
        slept.push(tab.id)
        total -= freed
      }
    }

    this.stats.lastSweepAt = Date.now()
    if (slept.length) this.emit()
    return slept
  }

  // ------------------------------------------------------------------ actions
  activeWebContents () {
    const tab = this.activeId != null ? this.tabs.get(this.activeId) : null
    return tab && tab.view ? tab.view.webContents : null
  }

  navigate (input, id = this.activeId) {
    const tab = this.tabs.get(id)
    if (!tab) return
    const url = normalizeInput(input)
    if (!url) return
    if (tab.suspended) this.wake(id)
    if (!tab.view) return
    tab.error = null
    tab.isNewTab = false
    tab.view.webContents.loadURL(url).catch((err) => {
      tab.loading = false
      tab.error = { code: -1, description: String(err && err.message ? err.message : err), url }
      this.emit()
    })
    tab.view.webContents.focus()
    this.emit()
  }

  back () { const wc = this.activeWebContents(); if (wc && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack() }
  forward () { const wc = this.activeWebContents(); if (wc && wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward() }
  stop () { const wc = this.activeWebContents(); if (wc) wc.stop() }
  reload (hard = false) {
    const wc = this.activeWebContents()
    if (!wc) return
    if (hard) wc.reloadIgnoringCache()
    else wc.reload()
  }

  // -------------------------------------------------------------- bookkeeping
  emit () {
    if (this.onState) this.onState(this.serialize())
  }

  sync (tab) {
    if (!tab.view) return
    const wc = tab.view.webContents
    try {
      const current = wc.getURL()
      const isLocalPage = Boolean(current) && current.startsWith(FILE_PREFIX) && current.includes('/renderer/')
      tab.isNewTab = !current || (isLocalPage && current.includes('newtab.html'))
      tab.isInternal = isLocalPage
      tab.url = isLocalPage ? '' : current
      tab.canGoBack = wc.navigationHistory.canGoBack()
      tab.canGoForward = wc.navigationHistory.canGoForward()
      if (!tab.keepAlive && tab.url && this.keepAliveFor(tab.url)) tab.keepAlive = true
    } catch (_) { /* view already gone */ }
  }

  serialize () {
    return {
      activeId: this.activeId,
      memoryMB: this.lastMemoryMB,
      stats: this.stats,
      tabs: this.order.map((id) => {
        const t = this.tabs.get(id)
        const title = t.suspended
          ? (t.title || t.url || 'Sleeping tab')
          : (t.isNewTab ? 'New Tab' : (t.title || t.url || 'New Tab'))
        return {
          id: t.id,
          title,
          url: t.url,
          favicon: t.favicon,
          loading: t.loading,
          canGoBack: t.canGoBack,
          canGoForward: t.canGoForward,
          hasError: Boolean(t.error),
          suspended: t.suspended,
          keepAlive: t.keepAlive,
          memoryMB: t.memoryMB,
          idleMs: Date.now() - t.lastActiveAt
        }
      })
    }
  }

  dumpState () {
    return {
      tabs: this.order
        .map((id) => this.tabs.get(id))
        .filter((t) => t && t.url && /^https?:/i.test(t.url))
        .map((t) => ({ url: t.url })),
      activeIndex: this.order.indexOf(this.activeId),
      keepAliveOrigins: [...this.keepAliveOrigins]
    }
  }

  // -------------------------------------------------------------- tab wiring
  wire (tab) {
    const wc = tab.view.webContents
    const emit = () => this.emit()

    wc.on('page-title-updated', (_e, title) => { tab.title = title; emit() })
    wc.on('page-favicon-updated', (_e, favicons) => {
      tab.favicon = Array.isArray(favicons) && favicons.length ? favicons[0] : null
      emit()
    })
    wc.on('did-start-loading', () => { tab.loading = true; tab.error = null; emit() })
    wc.on('did-stop-loading', () => { tab.loading = false; this.sync(tab); emit() })
    wc.on('did-navigate', () => { this.sync(tab); emit() })
    wc.on('did-navigate-in-page', (_e, url, isMainFrame) => { if (isMainFrame) { this.sync(tab); emit() } })
    wc.on('did-fail-load', (_e, code, description, validatedURL, isMainFrame) => {
      if (!isMainFrame || code === -3) return          // -3 = user aborted
      tab.loading = false
      tab.error = { code, description, url: validatedURL }
      this.sync(tab)
      emit()
    })
    wc.on('render-process-gone', (_e, details) => {
      tab.error = { code: -1, description: 'Renderer crashed: ' + details.reason, url: tab.url }
      emit()
    })
    wc.on('context-menu', (_e, params) => this.showContextMenu(tab, params))

    wc.setWindowOpenHandler(({ url, disposition }) => {
      if (/^(mailto|tel):/i.test(url)) {
        shell.openExternal(url)
        return { action: 'deny' }
      }
      if (disposition === 'foreground-tab' || disposition === 'background-tab') {
        this.create({ url, activate: disposition === 'foreground-tab' })
        return { action: 'deny' }
      }
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 1024,
          height: 720,
          minWidth: 480,
          minHeight: 400,
          parent: this.window,
          autoHideMenuBar: true,
          backgroundColor: '#202124',
          webPreferences: {
            session: this.sharedSession,
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true
          }
        }
      }
    })
  }

  showContextMenu (tab, params) {
    const wc = tab.view.webContents
    const items = []

    if (params.linkURL) {
      items.push({ label: 'Open Link in New Tab', click: () => this.create({ url: params.linkURL, activate: false }) })
      items.push({ label: 'Copy Link Address', click: () => clipboard.writeText(params.linkURL) })
      items.push({ type: 'separator' })
    }
    if (params.isEditable) {
      items.push({ role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }, { type: 'separator' })
    } else if (params.selectionText) {
      items.push({ label: 'Copy', role: 'copy' }, { type: 'separator' })
    }

    items.push({ label: 'Back', enabled: wc.navigationHistory.canGoBack(), click: () => wc.navigationHistory.goBack() })
    items.push({ label: 'Forward', enabled: wc.navigationHistory.canGoForward(), click: () => wc.navigationHistory.goForward() })
    items.push({ label: 'Reload', click: () => wc.reload() })
    items.push({ type: 'separator' })
    items.push({ label: 'Inspect Element', click: () => wc.inspectElement(params.x, params.y) })

    Menu.buildFromTemplate(items).popup()
  }
}

module.exports = { TabManager }
