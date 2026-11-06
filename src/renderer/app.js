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

function renderTab (tab) {
  const el = document.createElement('div')
  el.className = 'tab' + (tab.id === state.activeId ? ' active' : '') + (tab.loading ? ' loading' : '')
  el.dataset.id = String(tab.id)
  el.title = tab.title

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

  el.append(faviconNode(tab), title, close)

  el.addEventListener('click', () => window.shell.activateTab(tab.id))
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
