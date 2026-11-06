'use strict'

const listEl = document.getElementById('list')
const noticeEl = document.getElementById('notice')

let items = []

function showNotice (text, kind = 'error') {
  noticeEl.textContent = text
  noticeEl.className = 'notice' + (kind === 'ok' ? ' ok' : '')
  clearTimeout(showNotice.timer)
  showNotice.timer = setTimeout(() => noticeEl.classList.add('hidden'), 6000)
}

function iconNode (ext) {
  const el = document.createElement('div')
  el.className = 'icon'
  if (ext.icon) {
    const img = document.createElement('img')
    img.src = ext.icon
    img.alt = ''
    el.appendChild(img)
  } else {
    el.textContent = (ext.name || '?').trim().charAt(0).toUpperCase()
  }
  return el
}

function render (next) {
  items = next
  listEl.replaceChildren()

  if (!items.length) {
    const empty = document.createElement('p')
    empty.className = 'empty'
    empty.textContent = 'No extensions installed yet. Use “Load unpacked” with any folder that contains a manifest.json.'
    listEl.appendChild(empty)
    return
  }

  for (const ext of items) listEl.appendChild(renderCard(ext))
}

function renderCard (ext) {
  const card = document.createElement('article')
  card.className = 'card' + (ext.enabled ? '' : ' disabled')

  const body = document.createElement('div')

  const title = document.createElement('div')
  title.className = 'title'
  const name = document.createElement('span')
  name.className = 'name'
  name.textContent = ext.name
  const version = document.createElement('span')
  version.className = 'version'
  version.textContent = 'v' + ext.version
  const badge = document.createElement('span')
  badge.className = 'badge' + (ext.manifestVersion === 3 ? ' mv3' : '')
  badge.textContent = 'MV' + ext.manifestVersion
  const source = document.createElement('span')
  source.className = 'badge'
  source.textContent = ext.source
  title.append(name, version, badge, source)
  body.appendChild(title)

  if (ext.description) {
    const desc = document.createElement('p')
    desc.className = 'desc'
    desc.textContent = ext.description
    body.appendChild(desc)
  }

  const chips = document.createElement('div')
  chips.className = 'chips'
  for (const perm of ext.permissions.slice(0, 12)) {
    const chip = document.createElement('span')
    chip.className = 'chip'
    chip.textContent = perm
    chips.appendChild(chip)
  }
  body.appendChild(chips)

  if (ext.warnings && ext.warnings.length) {
    const list = document.createElement('ul')
    list.className = 'warnings'
    for (const warning of ext.warnings) {
      const li = document.createElement('li')
      li.textContent = warning
      list.appendChild(li)
    }
    body.appendChild(list)
  }

  const pathEl = document.createElement('div')
  pathEl.className = 'path'
  pathEl.textContent = ext.path
  body.appendChild(pathEl)

  const actions = document.createElement('div')
  actions.className = 'card-actions'

  const toggle = document.createElement('label')
  toggle.className = 'toggle'
  const switchEl = document.createElement('span')
  switchEl.className = 'switch'
  const input = document.createElement('input')
  input.type = 'checkbox'
  input.checked = ext.enabled
  input.addEventListener('change', async () => {
    const list = await window.extensionsApi.setEnabled(ext.id, input.checked)
    render(list)
  })
  const slider = document.createElement('span')
  slider.className = 'slider'
  switchEl.append(input, slider)
  toggle.append(switchEl)
  actions.appendChild(toggle)

  const reveal = document.createElement('button')
  reveal.className = 'linkbtn'
  reveal.textContent = 'Show folder'
  reveal.addEventListener('click', () => window.extensionsApi.reveal(ext.id))
  actions.appendChild(reveal)

  const remove = document.createElement('button')
  remove.className = 'linkbtn danger'
  remove.textContent = 'Remove'
  remove.addEventListener('click', async () => {
    const list = await window.extensionsApi.remove(ext.id)
    render(list)
    showNotice('Removed ' + ext.name, 'ok')
  })
  actions.appendChild(remove)

  card.append(iconNode(ext), body, actions)
  return card
}

document.getElementById('load-unpacked').addEventListener('click', async () => {
  const res = await window.extensionsApi.installUnpacked()
  if (res.canceled) return
  if (res.error) { render(res.list); return showNotice('Could not load: ' + res.error) }
  render(res.list)
  showNotice('Loaded ' + res.extension.name, 'ok')
})

document.getElementById('install-crx').addEventListener('click', async () => {
  const res = await window.extensionsApi.installCrx()
  if (res.canceled) return
  if (res.error) { render(res.list); return showNotice('Could not install: ' + res.error) }
  render(res.list)
  showNotice('Installed ' + res.extension.name, 'ok')
})

document.getElementById('reload-all').addEventListener('click', async () => {
  const list = await window.extensionsApi.reloadAll()
  render(list)
  showNotice('Extensions reloaded', 'ok')
})

window.extensionsApi.list().then(render)
