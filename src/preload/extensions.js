'use strict'

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('extensionsApi', {
  list: () => ipcRenderer.invoke('ext:list'),
  installUnpacked: () => ipcRenderer.invoke('ext:install-unpacked'),
  installCrx: () => ipcRenderer.invoke('ext:install-crx'),
  setEnabled: (id, enabled) => ipcRenderer.invoke('ext:set-enabled', id, enabled),
  remove: (id) => ipcRenderer.invoke('ext:remove', id),
  reveal: (id) => ipcRenderer.invoke('ext:reveal', id),
  reloadAll: () => ipcRenderer.invoke('ext:reload-all')
})
