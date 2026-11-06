'use strict'

const { contextBridge, ipcRenderer } = require('electron')

// The only bridge between the shell UI and the main process.
contextBridge.exposeInMainWorld('shell', {
  platform: process.platform,
  init: () => ipcRenderer.invoke('shell:init'),
  newTab: (url) => ipcRenderer.invoke('shell:new-tab', url),
  closeTab: (id) => ipcRenderer.invoke('shell:close-tab', id),
  activateTab: (id) => ipcRenderer.invoke('shell:activate-tab', id),
  navigate: (input) => ipcRenderer.invoke('shell:navigate', input),
  back: () => ipcRenderer.invoke('shell:back'),
  forward: () => ipcRenderer.invoke('shell:forward'),
  reload: () => ipcRenderer.invoke('shell:reload'),
  stop: () => ipcRenderer.invoke('shell:stop'),
  showMenu: () => ipcRenderer.invoke('shell:show-menu'),
  tabMenu: (id) => ipcRenderer.invoke('shell:tab-menu', id),
  setKeepAlive: (id, on) => ipcRenderer.invoke('shell:set-keep-alive', id, on),
  sleepTab: (id) => ipcRenderer.invoke('shell:sleep-tab', id),
  sweepTabs: () => ipcRenderer.invoke('shell:sweep'),
  openExtensionPopup: (id) => ipcRenderer.invoke('ext:open-popup', id),
  onExtensions: (callback) => {
    const handler = (_event, list) => callback(list)
    ipcRenderer.on('shell:extensions', handler)
    return () => ipcRenderer.removeListener('shell:extensions', handler)
  },
  onState: (callback) => {
    const handler = (_event, state) => callback(state)
    ipcRenderer.on('shell:state', handler)
    return () => ipcRenderer.removeListener('shell:state', handler)
  },
  onCommand: (callback) => {
    const handler = (_event, name, payload) => callback(name, payload)
    ipcRenderer.on('shell:command', handler)
    return () => ipcRenderer.removeListener('shell:command', handler)
  }
})
