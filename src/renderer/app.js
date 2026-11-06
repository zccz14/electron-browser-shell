'use strict'

const $ = (id) => document.getElementById(id)

const tabstrip = $('tabstrip')
const address = $('address')
const omnibox = $('omnibox')
const backBtn = $('back')
const forwardBtn = $('forward')
const reloadBtn = $('reload')

let state = { tabs: [], activeId: null }
let platform = 'darwin'

// ---------------------------------------------------------------- rendering
function activeTab () {
  return state.tabs.find((t) => t.id === state.activeId) || null
}

function faviconNode (tab) {
  const span = document.createElement('span')
  span.className = 'tab-favicon'
  if (tab.suspended) {
    span.classList.add('sleeping-icon')
    span.textContent = '\u263E'      // moon: this tab's renderer is released
    span.title = 'Sleeping — memory released'
    return span
  }
  if (tab.favicon) {
    const img = document.createElement('img')
    img.src = tab.favicon
    img.alt = ''
    img.addEventListener('error', () => {
      img.remove()
      span.textContent = (tab.title || '?').trim().charAt(0).toUpperCase()
    })
    span.appendChild(img)
  } else {
    span.textContent = (tab.title || '?').trim().charAt(0).toUpperCase()
  }
  return span
}

function pinNode () {
  const span = document.createElement('span')
  span.className = 'tab-pin'
  span.title = 'Kept awake — this tab will not be released'
  span.innerHTML = '<svg viewBox="0 0 16 16" width="10" height="10" aria-hidden="true">' +
    '<path d="M6 2h4l-.7 3.3 2.2 2.2v1.2H8.7L8 14.2l-.7-5.5H4.5V7.5l2.2-2.2L6 2z" fill="currentColor"/></svg>'
  return span
}

function renderTab (tab) {
  const el = document.createElement('div')
  el.className = 'tab' +
    (tab.id === state.activeId ? ' active' : '') +
    (tab.loading ? ' loading' : '') +
    (tab.suspended ? ' sleeping' : '') +
    (tab.keepAlive ? ' pinned' : '')
  el.dataset.id = String(tab.id)
  const bits = [tab.title]
  if (tab.url) bits.push(tab.url)
  if (tab.suspended) bits.push('sleeping — memory released')
  else if (tab.memoryMB) bits.push(tab.memoryMB + ' MB')
  if (tab.keepAlive) bits.push('kept awake')
  el.title = bits.join('\n')

  const title = document.createElement('span')
  title.className = 'tab-title'
  title.textContent = tab.title

  const close = document.createElement('button')
  close.className = 'tab-close'
  close.title = 'Close tab'
  close.innerHTML = '<svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true">' +
    '<path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" fill="none"/></svg>'
  close.addEventListener('click', (e) => {
    e.stopPropagation()
    window.shell.closeTab(tab.id)
  })

  el.append(faviconNode(tab), title)
  if (tab.keepAlive) el.appendChild(pinNode())
  el.append(close)

  el.addEventListener('click', () => window.shell.activateTab(tab.id))
  el.addEventListener('contextmenu', (e) => {
    e.preventDefault()
    e.stopPropagation()
    window.shell.tabMenu(tab.id)
  })
  el.addEventListener('auxclick', (e) => {
    if (e.button === 1) window.shell.closeTab(tab.id)     // middle click closes
  })

  return el
}

function render () {
  tabstrip.replaceChildren(...state.tabs.map(renderTab))

  const tab = activeTab()
  const url = tab ? tab.url : ''
  if (document.activeElement !== address) address.value = url
  address.placeholder = 'Search or enter address'

  backBtn.disabled = !(tab && tab.canGoBack)
  forwardBtn.disabled = !(tab && tab.canGoForward)
  reloadBtn.classList.toggle('loading', Boolean(tab && tab.loading))
}

// ------------------------------------------------------------------ actions
$('newtab').addEventListener('click', () => window.shell.newTab())
backBtn.addEventListener('click', () => window.shell.back())
forwardBtn.addEventListener('click', () => window.shell.forward())
reloadBtn.addEventListener('click', () => {
  const tab = activeTab()
  if (tab && tab.loading) window.shell.stop()
  else window.shell.reload()
})

$('menu').addEventListener('click', () => window.shell.showMenu())

omnibox.addEventListener('submit', (e) => {
  e.preventDefault()
  const value = address.value.trim()
  if (!value) return
  window.shell.navigate(value)
  address.blur()
})

address.addEventListener('focus', () => address.select())
address.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    const tab = activeTab()
    address.value = tab ? tab.url : ''
    address.blur()
  }
})

document.addEventListener('keydown', (e) => {
  const meta = platform === 'darwin' ? e.metaKey : e.ctrlKey
  if (meta && e.key.toLowerCase() === 'l') {
    e.preventDefault()
    address.focus()
  }
  if (meta && e.key.toLowerCase() === 't') {
    e.preventDefault()
    window.shell.newTab()
  }
  if (meta && e.key.toLowerCase() === 'w') {
    e.preventDefault()
    const tab = activeTab()
    if (tab) window.shell.closeTab(tab.id)
  }
  if (meta && e.key.toLowerCase() === 'r') {
    e.preventDefault()
    window.shell.reload()
  }
})

// ------------------------------------------------------------------- wiring
window.shell.onState((next) => {
  state = next
  render()
})

window.shell.onExtensions((list) => {
  const host = document.getElementById('ext-actions')
  host.replaceChildren()
  for (const ext of list) {
    if (!ext.enabled || !ext.popupPath) continue
    const btn = document.createElement('button')
    btn.className = 'iconbtn ext-btn'
    btn.title = ext.name
    if (ext.icon) {
      const img = document.createElement('img')
      img.src = ext.icon
      img.alt = ''
      btn.appendChild(img)
    } else {
      btn.textContent = (ext.name || '?').charAt(0).toUpperCase()
    }
    btn.addEventListener('click', () => window.shell.openExtensionPopup(ext.id))
    host.appendChild(btn)
  }
})

window.shell.onCommand((name) => {
  if (name === 'focus-address') {
    address.focus()
    address.select()
  }
})

window.shell.init().then((info) => {
  platform = info.platform
  document.body.classList.add(platform === 'darwin' ? 'is-mac' : 'is-win')
  state = info.state
  render()
})
