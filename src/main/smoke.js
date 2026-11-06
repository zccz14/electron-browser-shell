'use strict'

// Headless-ish self check: runs the real app, drives a few tab operations and
// writes PNG screenshots of the shell UI and the active tab.
//   npx electron . --smoke --smoke-out=/tmp/browser-shell-smoke
const path = require('node:path')
const fs = require('node:fs')
const { execFileSync } = require('node:child_process')
const { pathToFileURL } = require('node:url')

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function argValue (name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : fallback
}

function captureViaCdp (webContents) {
  return new Promise((resolve, reject) => {
    const dbg = webContents.debugger
    try {
      if (!dbg.isAttached()) dbg.attach('1.3')
    } catch (err) {
      return reject(err)
    }
    dbg.sendCommand('Page.captureScreenshot', { format: 'png', fromSurface: true })
      .then((res) => resolve(Buffer.from(res.data, 'base64')))
      .catch(reject)
  })
}

async function capture (webContents, file) {
  // capturePage() returns the last composited frame, which goes stale whenever
  // the window is occluded (or there is no display at all). The DevTools
  // protocol path forces a fresh raster, so it is the reliable one here.
  let buffer
  let method = 'cdp'
  try {
    buffer = await captureViaCdp(webContents)
  } catch (_) {
    method = 'capturePage'
    const image = await webContents.capturePage()
    buffer = image.toPNG()
  }
  fs.writeFileSync(file, buffer)
  return { file, bytes: buffer.length, method }
}

async function waitForLoad (tabs, id, timeout = 15000) {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    const tab = tabs.tabs.get(id)
    if (tab && !tab.loading && tab.url) return true
    await wait(200)
  }
  return false
}

async function runSmoke ({ window, chromeView, tabs, extensions, openExtensionPopup }) {
  const outDir = argValue('smoke-out', path.join(require('node:os').tmpdir(), 'browser-shell-smoke'))
  fs.mkdirSync(outDir, { recursive: true })

  const report = { outDir, ok: true, steps: [] }
  const fails = []

  try {
    await wait(1500)
    report.steps.push({
      step: 'initial',
      state: tabs.serialize(),
      chromeHeight: chromeView.getBounds().height,
      capture: await capture(chromeView.webContents, path.join(outDir, '01-new-tab.png'))
    })

    // --- extensions: install the bundled sample --------------------------
    for (const existing of extensions.list()) await extensions.remove(existing.id)
    const sampleDir = path.join(__dirname, '..', '..', 'examples', 'sample-extension')
    const sample = await extensions.installFromDirectory(sampleDir, { copy: true })
    if (!sample || !sample.id) fails.push('sample extension did not load')
    report.steps.push({ step: 'extension-install', installed: { id: sample.id, name: sample.name, mv: sample.manifestVersion, warnings: sample.warnings } })

    // --- multiple tabs -----------------------------------------------------
    const example = tabs.create({ url: 'https://example.com', activate: true })
    const github = tabs.create({ url: 'https://github.com', activate: false })
    await waitForLoad(tabs, example)
    await waitForLoad(tabs, github)
    await wait(600)
    tabs.activate(github)
    await wait(900)

    report.steps.push({
      step: 'multi-tab',
      state: tabs.serialize(),
      chromeCapture: await capture(chromeView.webContents, path.join(outDir, '02-tabs.png')),
      contentCapture: await capture(tabs.activeWebContents(), path.join(outDir, '03-active-tab.png'))
    })

    // --- the extension actually ran inside the page -----------------------
    const banner = await tabs.tabs.get(example).view.webContents.executeJavaScript(
      "(() => { const el = document.getElementById('browser-shell-sample-banner'); return el ? el.textContent : null })()"
    )
    if (!banner) fails.push('content script of the sample extension did not run on example.com')

    report.steps.push({ step: 'extension-content-script', banner })

    // --- the extension's popup opens in its own window --------------------
    let popupStep = { opened: false }
    try {
      const popup = openExtensionPopup(sample.id)
      await wait(1800)
      if (!popup || popup.isDestroyed()) throw new Error('popup window did not open')
      const popupText = await popup.webContents.executeJavaScript('document.body.innerText')
      popupStep = {
        opened: true,
        text: String(popupText || '').replace(/\s+/g, ' ').trim().slice(0, 120),
        capture: await capture(popup.webContents, path.join(outDir, '08-popup.png'))
      }
      popup.destroy()
    } catch (err) {
      popupStep = { opened: false, error: String(err && err.message ? err.message : err) }
      fails.push('extension popup did not render: ' + popupStep.error)
    }
    report.steps.push({ step: 'extension-popup', ...popupStep })

    // --- .crx install path (Electron cannot load .crx, we unpack it) ------
    let crxOutcome = 'skipped'
    try {
      const zipFile = path.join(outDir, 'sample.zip')
      execFileSync('zip', ['-qr', zipFile, '.'], { cwd: sampleDir })
      const zip = fs.readFileSync(zipFile)
      const header = Buffer.alloc(4)
      header.writeUInt32LE(0, 0)
      const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n, 0); return b }
      const crxFile = path.join(outDir, 'sample.crx')
      fs.writeFileSync(crxFile, Buffer.concat([Buffer.from('Cr24'), u32(3), u32(header.length), header, zip]))
      const fromCrx = await extensions.installFromCrx(crxFile)
      if (!fromCrx || !fromCrx.id) throw new Error('extension did not load from .crx')
      crxOutcome = 'installed ' + fromCrx.name
      await extensions.remove(fromCrx.id)
    } catch (err) {
      crxOutcome = 'skipped: ' + (err && err.message ? err.message : err)
    }
    report.steps.push({ step: 'extension-crx', outcome: crxOutcome })

    // --- the extensions page itself ---------------------------------------
    const extPageId = tabs.create({
      url: pathToFileURL(path.join(__dirname, '..', 'renderer', 'extensions.html')).toString(),
      preload: path.join(__dirname, '..', 'preload', 'extensions.js'),
      activate: true
    })
    await waitForLoad(tabs, extPageId)
    await wait(1200)
    const cards = await tabs.tabs.get(extPageId).view.webContents.executeJavaScript(
      "document.querySelectorAll('.card').length"
    )
    if (!cards) fails.push('extensions page rendered no cards')
    report.steps.push({
      step: 'extensions-page',
      cards,
      capture: await capture(tabs.tabs.get(extPageId).view.webContents, path.join(outDir, '07-extensions.png'))
    })
    tabs.close(extPageId)
    await wait(400)

    // --- navigation + history ---------------------------------------------
    tabs.navigate('example.com')
    await waitForLoad(tabs, github)
    await wait(400)
    const afterNavigate = tabs.serialize()
    const active = afterNavigate.tabs.find((t) => t.id === afterNavigate.activeId)
    if (!active || !active.url.includes('example.com')) fails.push('omnibox navigation did not reach example.com')
    if (!active || !active.canGoBack) fails.push('back button state not updated after navigation')

    tabs.back()
    await wait(1200)
    const afterBack = tabs.serialize()
    const backTab = afterBack.tabs.find((t) => t.id === afterBack.activeId)
    if (!backTab || !backTab.url.includes('github.com')) fails.push('back did not return to github.com')

    report.steps.push({
      step: 'navigation',
      afterNavigate: active,
      afterBack: backTab,
      chromeCapture: await capture(chromeView.webContents, path.join(outDir, '04-after-back.png'))
    })

    // --- real UI round trip: click a tab, type in the omnibox -------------
    // This exercises the preload bridge + IPC, which the steps above bypass.
    const firstTabId = tabs.order[0]
    await chromeView.webContents.executeJavaScript(`
      (() => {
        const el = document.querySelector('.tab')
        if (!el) throw new Error('no tab element rendered')
        el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
        return document.querySelectorAll('.tab').length
      })()
    `)
    await wait(500)
    if (tabs.serialize().activeId !== firstTabId) fails.push('clicking a tab in the shell UI did not activate it')

    await chromeView.webContents.executeJavaScript(`
      (() => {
        const input = document.getElementById('address')
        input.focus()
        input.value = 'example.com'
        document.getElementById('omnibox').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }))
      })()
    `)
    await waitForLoad(tabs, firstTabId)
    await wait(400)
    const afterOmnibox = tabs.serialize().tabs.find((t) => t.id === firstTabId)
    if (!afterOmnibox || !afterOmnibox.url.includes('example.com')) fails.push('typing in the omnibox did not navigate the active tab')

    report.steps.push({
      step: 'ui-round-trip',
      clickedTabId: firstTabId,
      afterOmnibox,
      activeId: tabs.serialize().activeId,
      chromeCapture: await capture(chromeView.webContents, path.join(outDir, '05-omnibox.png'))
    })

    // --- close tabs --------------------------------------------------------
    tabs.close(example)
    await wait(500)
    const afterClose = tabs.serialize()
    if (afterClose.tabs.length !== 2) fails.push(`expected 2 tabs after close, got ${afterClose.tabs.length}`)

    report.steps.push({ step: 'close-tab', state: afterClose })

    // --- resize ------------------------------------------------------------
    window.setContentSize(1100, 720)
    await wait(600)
    const chromeBounds = chromeView.getBounds()
    const tabBounds = tabs.tabs.get(tabs.activeId).view.getBounds()
    if (tabBounds.y !== chromeBounds.height) fails.push('content view does not start right below the chrome')
    if (tabBounds.width !== chromeBounds.width) fails.push('content view width does not match the chrome')
    report.steps.push({
      step: 'resize',
      chromeBounds,
      contentBounds: tabBounds,
      chromeCapture: await capture(chromeView.webContents, path.join(outDir, '06-resized.png'))
    })
  } catch (err) {
    fails.push(`exception: ${err && err.stack ? err.stack : err}`)
  }

  report.failures = fails
  report.ok = fails.length === 0
  const reportFile = path.join(outDir, 'report.json')
  fs.writeFileSync(reportFile, JSON.stringify(report, null, 2))
  console.log('SMOKE_RESULT ' + JSON.stringify({
    ok: report.ok,
    failures: fails,
    outDir,
    reportFile,
    steps: report.steps.map((s) => ({ step: s.step, capture: s.capture || s.chromeCapture }))
  }))
  return report.ok ? 0 : 1
}

module.exports = { runSmoke }
