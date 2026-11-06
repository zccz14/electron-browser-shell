'use strict'

const path = require('node:path')
const fs = require('node:fs')
const { app, BaseWindow, WebContentsView, BrowserWindow, ipcMain, Menu, session, shell, dialog } = require('electron')

const { TabManager } = require('./tabs')
const { buildMenu } = require('./menu')
const { runSmoke } = require('./smoke')
const { ExtensionHost } = require('./extensions')

// Smoke runs must not touch the real profile (extensions, session, storage).
if (process.argv.includes('--smoke')) {
  app.setPath('userData', path.join(require('node:os').tmpdir(), 'browser-shell-smoke-profile'))
}

// Height of the shell's own chrome (tab strip + toolbar). The web content
// views start right below it.
const CHROME_HEIGHT = 88
const isMac = process.platform === 'darwin'

let mainWindow = null
let chromeView = null
let tabs = null
let sharedSession = null
let extensionHost = null

// ------------------------------------------------------------------ session
const sessionFile = () => path.join(app.getPath('userData'), 'session.json')

function loadSession () {
  try {
    const data = JSON.parse(fs.readFileSync(sessionFile(), 'utf8'))
    if (Array.isArray(data.tabs)) return data
  } catch (_) { /* first run */ }
  return null
}

function saveSession () {
  if (!tabs) return
  try {
    fs.mkdirSync(path.dirname(sessionFile()), { recursive: true })
    fs.writeFileSync(sessionFile(), JSON.stringify(tabs.dumpState(), null, 2))
  } catch (err) {
    console.error('[shell] could not save session:', err)
  }
}

// ------------------------------------------------------------------- window
function pushState (state) {
  if (chromeView && !chromeView.webContents.isDestroyed()) {
    chromeView.webContents.send('shell:state', state)
  }
}

function sendCommand (name, payload) {
  if (!chromeView || chromeView.webContents.isDestroyed()) return
  if (name === 'focus-address') chromeView.webContents.focus()
  chromeView.webContents.send('shell:command', name, payload)
}

function broadcastExtensions () {
  if (!extensionHost || !chromeView || chromeView.webContents.isDestroyed()) return
  chromeView.webContents.send('shell:extensions', extensionHost.list())
}

function openExtensionPopup (id) {
  if (!extensionHost) return null
  const url = extensionHost.popupUrl(id)
  if (!url) return null
  const popup = new BrowserWindow({
    width: 380,
    height: 440,
    parent: mainWindow || undefined,
    autoHideMenuBar: true,
    resizable: true,
    title: 'Extension',
    backgroundColor: '#202124',
    webPreferences: {
      session: sharedSession,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  popup.loadURL(url)
  return popup
}

function openExtensionsPage () {
  if (!tabs) return
  tabs.create({
    url: require('node:url').pathToFileURL(path.join(__dirname, '..', 'renderer', 'extensions.html')).toString(),
    preload: path.join(__dirname, '..', 'preload', 'extensions.js'),
    activate: true
  })
}

function layout () {
  if (!mainWindow || mainWindow.isDestroyed() || !chromeView) return
  const [width, height] = mainWindow.getContentSize()
  chromeView.setBounds({ x: 0, y: 0, width, height: CHROME_HEIGHT })
  if (tabs) tabs.layout({ width, height: Math.max(0, height - CHROME_HEIGHT) })
}

function createWindow () {
  mainWindow = new BaseWindow({
    width: 1280,
    height: 860,
    minWidth: 720,
    minHeight: 480,
    backgroundColor: '#202124',
    show: false,
    ...(isMac
      ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 16, y: 15 } }
      : { titleBarStyle: 'hidden', titleBarOverlay: { color: '#202124', symbolColor: '#e8eaed', height: 42 } })
  })

  // 1) The shell's own UI is just a web page rendered in its own view.
  chromeView = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'chrome.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false
    }
  })
  chromeView.setBackgroundColor('#202124')
  mainWindow.contentView.addChildView(chromeView)
  chromeView.webContents.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'))

  // 2) Every tab is a WebContentsView attached to the same window.
  tabs = new TabManager({
    window: mainWindow,
    session: sharedSession,
    topInset: CHROME_HEIGHT,
    onState: pushState
  })

  const saved = loadSession()
  if (saved && saved.tabs.length) {
    for (const entry of saved.tabs) tabs.create({ url: entry.url, activate: false })
    const index = Number.isInteger(saved.activeIndex) ? saved.activeIndex : 0
    const target = tabs.order[index] != null ? tabs.order[index] : tabs.order[0]
    if (target != null) tabs.activate(target)
  } else {
    tabs.create({})
  }

  mainWindow.on('resize', layout)
  mainWindow.on('enter-full-screen', layout)
  mainWindow.on('leave-full-screen', layout)
  mainWindow.on('maximize', layout)
  mainWindow.on('unmaximize', layout)
  mainWindow.on('close', saveSession)
  mainWindow.on('closed', () => {
    mainWindow = null
    chromeView = null
    tabs = null
  })

  chromeView.webContents.once('did-finish-load', () => {
    layout()
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.show()

    broadcastExtensions()

    if (process.argv.includes('--smoke')) {
      const timer = setTimeout(() => {
        console.error('SMOKE_RESULT ' + JSON.stringify({ ok: false, failures: ['timeout'] }))
        app.exit(1)
      }, 90000)
      runSmoke({ window: mainWindow, chromeView, tabs, extensions: extensionHost, openExtensionPopup, broadcastExtensions })
        .then((code) => { clearTimeout(timer); app.exit(code) })
        .catch((err) => {
          clearTimeout(timer)
          console.error('SMOKE_RESULT ' + JSON.stringify({ ok: false, failures: [String(err)] }))
          app.exit(1)
        })
    }
  })

  layout()
}

// ---------------------------------------------------------------------- IPC
function registerIpc () {
  ipcMain.handle('shell:init', () => ({
    platform: process.platform,
    chromeHeight: CHROME_HEIGHT,
    state: tabs ? tabs.serialize() : { tabs: [], activeId: null }
  }))

  ipcMain.handle('shell:new-tab', (_e, url) => tabs && tabs.create({ url: url || null }))
  ipcMain.handle('shell:close-tab', (_e, id) => tabs && tabs.close(id))
  ipcMain.handle('shell:activate-tab', (_e, id) => tabs && tabs.activate(id))
  ipcMain.handle('shell:navigate', (_e, input) => tabs && tabs.navigate(input))
  ipcMain.handle('shell:back', () => tabs && tabs.back())
  ipcMain.handle('shell:forward', () => tabs && tabs.forward())
  ipcMain.handle('shell:reload', () => tabs && tabs.reload())
  ipcMain.handle('shell:stop', () => tabs && tabs.stop())
  ipcMain.handle('ext:list', () => (extensionHost ? extensionHost.list() : []))
  ipcMain.handle('ext:open-popup', (_e, id) => {
    const popup = openExtensionPopup(id)
    return Boolean(popup)
  })
  ipcMain.handle('ext:install-unpacked', async () => {
    if (!extensionHost || !mainWindow) return { canceled: true }
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Load unpacked extension',
      properties: ['openDirectory'],
      message: 'Pick a folder that contains manifest.json'
    })
    if (result.canceled || !result.filePaths.length) return { canceled: true }
    try {
      const ext = await extensionHost.installFromDirectory(result.filePaths[0], { copy: true })
      broadcastExtensions()
      return { extension: ext, list: extensionHost.list() }
    } catch (err) {
      return { error: String(err.message || err), list: extensionHost.list() }
    }
  })
  ipcMain.handle('ext:install-crx', async () => {
    if (!extensionHost || !mainWindow) return { canceled: true }
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Install .crx extension',
      properties: ['openFile'],
      filters: [{ name: 'Chrome extension', extensions: ['crx'] }]
    })
    if (result.canceled || !result.filePaths.length) return { canceled: true }
    try {
      const ext = await extensionHost.installFromCrx(result.filePaths[0])
      broadcastExtensions()
      return { extension: ext, list: extensionHost.list() }
    } catch (err) {
      return { error: String(err.message || err), list: extensionHost.list() }
    }
  })
  ipcMain.handle('ext:set-enabled', async (_e, id, enabled) => {
    if (!extensionHost) return []
    await extensionHost.setEnabled(id, enabled)
    broadcastExtensions()
    return extensionHost.list()
  })
  ipcMain.handle('ext:remove', async (_e, id) => {
    if (!extensionHost) return []
    await extensionHost.remove(id)
    broadcastExtensions()
    return extensionHost.list()
  })
  ipcMain.handle('ext:reveal', (_e, id) => {
    const ext = extensionHost && extensionHost.list().find((e) => e.id === id)
    if (ext) shell.showItemInFolder(ext.path)
  })
  ipcMain.handle('ext:reload-all', async () => {
    if (!extensionHost) return []
    for (const ext of extensionHost.list()) {
      if (!ext.enabled) continue
      await extensionHost.setEnabled(ext.id, false).catch(() => {})
      await extensionHost.setEnabled(ext.id, true).catch(() => {})
    }
    broadcastExtensions()
    return extensionHost.list()
  })

  ipcMain.handle('shell:show-menu', () => {
    if (!mainWindow) return
    Menu.buildFromTemplate([
      { label: 'New Tab', accelerator: 'CmdOrCtrl+T', click: () => tabs && tabs.create({}) },
      { label: 'Close Tab', accelerator: 'CmdOrCtrl+W', click: () => tabs && tabs.closeActive() },
      { type: 'separator' },
      { label: 'Reload', accelerator: 'CmdOrCtrl+R', click: () => tabs && tabs.reload() },
      { label: 'Toggle DevTools', accelerator: isMac ? 'Alt+Cmd+I' : 'Ctrl+Shift+I', click: () => { const wc = tabs && tabs.activeWebContents(); if (wc) wc.toggleDevTools() } },
      { type: 'separator' },
      { label: 'Extensions', accelerator: 'CmdOrCtrl+Shift+E', click: () => openExtensionsPage() },
      { type: 'separator' },
      isMac ? { role: 'about' } : { role: 'quit' }
    ]).popup({ window: mainWindow })
  })
}

function menuContext () {
  return {
    newTab: () => tabs && tabs.create({}),
    closeTab: () => tabs && tabs.closeActive(),
    reload: () => tabs && tabs.reload(),
    hardReload: () => tabs && tabs.reload(true),
    back: () => tabs && tabs.back(),
    forward: () => tabs && tabs.forward(),
    nextTab: () => tabs && tabs.cycle(1),
    prevTab: () => tabs && tabs.cycle(-1),
    focusAddressBar: () => sendCommand('focus-address'),
    openExtensions: () => openExtensionsPage(),
    toggleDevTools: () => {
      const wc = tabs && tabs.activeWebContents()
      if (wc) wc.toggleDevTools()
    }
  }
}

// ------------------------------------------------------------------ lifecycle
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  app.whenReady().then(async () => {
    // One persistent session for the whole shell: cookies/logins are shared
    // between tabs exactly like a real browser.
    sharedSession = session.fromPartition('persist:shell')

    // Extensions have to be loaded into the session before the first page,
    // otherwise content scripts never run.
    extensionHost = new ExtensionHost({ session: sharedSession, userDataDir: app.getPath('userData') })
    await extensionHost.loadAll()

    registerIpc()
    createWindow()
    Menu.setApplicationMenu(buildMenu(menuContext()))

    app.on('activate', () => {
      if (!mainWindow) createWindow()
    })

    // Non-http schemes (mailto:, tel:) go to the OS, never to a tab.
    app.on('web-contents-created', (_event, contents) => {
      contents.on('will-navigate', (event, url) => {
        if (/^(mailto|tel):/i.test(url)) {
          event.preventDefault()
          shell.openExternal(url)
        }
      })
    })
  })

  app.on('before-quit', saveSession)

  app.on('window-all-closed', () => {
    if (!isMac) app.quit()
  })
}
