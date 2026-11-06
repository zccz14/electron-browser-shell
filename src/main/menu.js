'use strict'

const { Menu, shell } = require('electron')

const isMac = process.platform === 'darwin'

/**
 * Application menu. Accelerators here fire no matter which view has focus —
 * that is how a shell intercepts Cmd+T / Cmd+W / Cmd+L before the page does.
 */
function buildMenu (ctx) {
  const template = []

  if (isMac) template.push({ role: 'appMenu' })

  template.push({
    label: 'File',
    submenu: [
      { label: 'New Tab', accelerator: 'CmdOrCtrl+T', click: () => ctx.newTab() },
      { label: 'Close Tab', accelerator: 'CmdOrCtrl+W', click: () => ctx.closeTab() },
      { type: 'separator' },
      { label: 'Extensions…', accelerator: 'CmdOrCtrl+Shift+E', click: () => ctx.openExtensions() },
      { type: 'separator' },
      isMac
        ? { role: 'close', label: 'Close Window', accelerator: 'CmdOrCtrl+Shift+W' }
        : { role: 'quit' }
    ]
  })

  template.push({
    label: 'Edit',
    submenu: [
      { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
      { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'pasteAndMatchStyle' },
      { role: 'selectAll' }
    ]
  })

  template.push({
    label: 'View',
    submenu: [
      { label: 'Reload', accelerator: 'CmdOrCtrl+R', click: () => ctx.reload() },
      { label: 'Force Reload', accelerator: 'CmdOrCtrl+Shift+R', click: () => ctx.hardReload() },
      { label: 'Toggle DevTools', accelerator: isMac ? 'Alt+Cmd+I' : 'Ctrl+Shift+I', click: () => ctx.toggleDevTools() },
      { type: 'separator' },
      { label: 'Sleep Background Tabs Now', accelerator: 'CmdOrCtrl+Shift+S', click: () => ctx.sleepBackgroundTabs() },
      { type: 'separator' },
      { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
      { type: 'separator' },
      { role: 'togglefullscreen' }
    ]
  })

  template.push({
    label: 'History',
    submenu: [
      { label: 'Back', accelerator: isMac ? 'Cmd+Left' : 'Alt+Left', click: () => ctx.back() },
      { label: 'Forward', accelerator: isMac ? 'Cmd+Right' : 'Alt+Right', click: () => ctx.forward() },
      { type: 'separator' },
      { label: 'Next Tab', accelerator: 'Ctrl+Tab', click: () => ctx.nextTab() },
      { label: 'Previous Tab', accelerator: 'Ctrl+Shift+Tab', click: () => ctx.prevTab() },
      { type: 'separator' },
      { label: 'Focus Address Bar', accelerator: 'CmdOrCtrl+L', click: () => ctx.focusAddressBar() }
    ]
  })

  template.push({ role: 'windowMenu' })

  template.push({
    role: 'help',
    submenu: [
      { label: 'GitHub Repository', click: () => shell.openExternal('https://github.com/zccz14/electron-browser-shell') }
    ]
  })

  return Menu.buildFromTemplate(template)
}

module.exports = { buildMenu }
