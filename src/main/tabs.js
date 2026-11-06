'use strict'

const path = require('node:path')
const { WebContentsView, Menu, clipboard, shell } = require('electron')
const { normalizeInput } = require('./urls')

const NEW_TAB_PAGE = path.join(__dirname, '..', 'renderer', 'newtab.html')
const NEW_TAB_URL_PREFIX = 'file://'

let nextId = 1

/**
 * One WebContentsView per tab — the same model a real browser uses.
 * Inactive tabs stay alive (like Chrome); switching tabs just re-attaches the
 * view to the window instead of reloading the page.
 */
class TabManager {
  constructor ({ window, session, topInset = 88, onState }) {
    this.window = window
    this.sharedSession = session
    this.topInset = topInset
    this.onState = onState

    this.tabs = new Map()   // id -> tab record
    this.order = []         // tab order, left to right
    this.activeId = null
    this.viewport = { x: 0, y: topInset, width: 0, height: 0 }
    this.destroying = false
  }

  // ---------------------------------------------------------------- lifecycle
  create ({ url = null, activate = true } = {}) {
    const id = nextId++
    const view = new WebContentsView({
      webPreferences: {
        session: this.sharedSession,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: true
      }
    })
    view.setBackgroundColor('#202124')

    const tab = {
      id,
      view,
      title: '',
      url: '',
      favicon: null,
      loading: false,
      canGoBack: false,
      canGoForward: false,
      isNewTab: !url,
      error: null
    }

    this.tabs.set(id, tab)
    this.order.push(id)
    this.wire(tab)

    if (url) view.webContents.loadURL(url)
    else view.webContents.loadFile(NEW_TAB_PAGE)

    if (activate) this.activate(id)
    this.emit()
    return id
  }

  close (id) {
    const tab = this.tabs.get(id)
    if (!tab) return

    const index = this.order.indexOf(id)
    this.order.splice(index, 1)
    this.tabs.delete(id)

    try { this.window.contentView.removeChildView(tab.view) } catch (_) {}
    try { tab.view.webContents.close() } catch (_) {}

    if (this.activeId === id) {
      this.activeId = null
      if (this.destroying) return this.emit()
      const next = this.order[index] || this.order[index - 1] || this.order[0]
      if (next != null) this.activate(next)
      else this.create({})            // a browser always has at least one tab
    }
    this.emit()
  }

  closeActive () {
    if (this.activeId != null) this.close(this.activeId)
  }

  activate (id) {
    const tab = this.tabs.get(id)
    if (!tab || this.destroying) return

    const prev = this.activeId != null ? this.tabs.get(this.activeId) : null
    if (prev && prev.id !== id) {
      try { this.window.contentView.removeChildView(prev.view) } catch (_) {}
    }

    this.activeId = id
    if (!this.window.contentView.children.includes(tab.view)) {
      this.window.contentView.addChildView(tab.view)
    }
    tab.view.setBounds(this.viewport)
    tab.view.webContents.focus()
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
    if (tab) tab.view.setBounds(this.viewport)
  }

  destroyAll () {
    this.destroying = true
    for (const id of [...this.order]) this.close(id)
  }

  // ------------------------------------------------------------------ actions
  activeWebContents () {
    const tab = this.activeId != null ? this.tabs.get(this.activeId) : null
    return tab ? tab.view.webContents : null
  }

  navigate (input, id = this.activeId) {
    const tab = this.tabs.get(id)
    if (!tab) return
    const url = normalizeInput(input)
    if (!url) return
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
    const wc = tab.view.webContents
    try {
      const current = wc.getURL()
      tab.isNewTab = !current || (current.startsWith(NEW_TAB_URL_PREFIX) && current.includes('newtab.html'))
      tab.url = tab.isNewTab ? '' : current
      tab.canGoBack = wc.navigationHistory.canGoBack()
      tab.canGoForward = wc.navigationHistory.canGoForward()
    } catch (_) { /* view already gone */ }
  }

  serialize () {
    return {
      activeId: this.activeId,
      tabs: this.order.map((id) => {
        const t = this.tabs.get(id)
        const title = t.isNewTab ? 'New Tab' : (t.title || t.url || 'New Tab')
        return {
          id: t.id,
          title,
          url: t.url,
          favicon: t.favicon,
          loading: t.loading,
          canGoBack: t.canGoBack,
          canGoForward: t.canGoForward,
          hasError: Boolean(t.error)
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
      activeIndex: this.order.indexOf(this.activeId)
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

    // target=_blank / window.open: real browser behaviour.
    // Tabs stay in the shell, popup windows (OAuth, payments) get a native
    // window that shares the same session — so cookies and window.opener work.
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
