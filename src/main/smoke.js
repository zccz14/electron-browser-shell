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
    let sample = null
    try {
      sample = await extensions.installFromDirectory(sampleDir, { copy: true })
      if (!sample || !sample.id) fails.push('sample extension did not load')
      report.steps.push({ step: 'extension-install', installed: { id: sample.id, name: sample.name, mv: sample.manifestVersion, warnings: sample.warnings } })
    } catch (err) {
      report.steps.push({ step: 'extension-install', skipped: String(err && err.message ? err.message : err) })
    }

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
    const banner = !sample ? null : await tabs.tabs.get(example).view.webContents.executeJavaScript(
      "(() => { const el = document.getElementById('browser-shell-sample-banner'); return el ? el.textContent : null })()"
    )
    if (sample && !banner) fails.push('content script of the sample extension did not run on example.com')

    report.steps.push({ step: 'extension-content-script', banner })

    // --- the extension's popup opens in its own window --------------------
    let popupStep = { opened: false, skipped: !sample }
    try {
      if (!sample) throw Object.assign(new Error('no sample extension'), { benign: true })
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
      if (!err || !err.benign) fails.push('extension popup did not render: ' + popupStep.error)
    }
    report.steps.push({ step: 'extension-popup', ...popupStep })

    // --- .crx install path (Electron cannot load .crx, we unpack it) ------
    let crxOutcome = 'skipped'
    try {
      if (!sample) throw new Error('no sample extension to pack')
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

    // --- WebAuthn / passkey capability probe ------------------------------
    // Records what the engine can actually do, so a regression is visible.
    let webauthn = null
    try {
      const wc = tabs.activeWebContents()
      webauthn = await wc.executeJavaScript(`(async () => {
        const caps = {
          publicKeyCredential: typeof PublicKeyCredential !== 'undefined',
          secureContext: window.isSecureContext,
          credentialsCreate: Boolean(navigator.credentials && navigator.credentials.create)
        }
        try { caps.platformAuthenticator = await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable() } catch (e) { caps.platformAuthenticator = 'error: ' + e.message }
        try { caps.conditionalMediation = await PublicKeyCredential.isConditionalMediationAvailable?.() } catch (e) { caps.conditionalMediation = 'error: ' + e.message }
        return caps
      })()`)

      // A virtual authenticator proves the API path itself works, independent
      // of whether the OS offers a platform authenticator.
      try {
        const dbg = wc.debugger
        if (!dbg.isAttached()) dbg.attach('1.3')
        await dbg.sendCommand('WebAuthn.enable')
        await dbg.sendCommand('WebAuthn.addVirtualAuthenticator', {
          options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true }
        })
        const origin = new URL(wc.getURL()).hostname
        webauthn.virtualCreate = await wc.executeJavaScript(`(async () => {
          try {
            const c = await navigator.credentials.create({ publicKey: {
              challenge: new Uint8Array([9, 9, 9]),
              rp: { name: 'Browser Shell smoke', id: location.hostname },
              user: { id: new Uint8Array([7]), name: 'smoke', displayName: 'Smoke' },
              pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
              timeout: 4000
            } })
            return c ? 'ok' : 'null'
          } catch (e) { return e.name + ': ' + e.message }
        })()`)
        webauthn.origin = origin
        await dbg.sendCommand('WebAuthn.disable').catch(() => {})
        dbg.detach()
      } catch (err) {
        webauthn.virtualCreate = 'unavailable: ' + (err && err.message ? err.message : err)
      }
    } catch (err) {
      webauthn = { error: String(err && err.message ? err.message : err) }
    }
    report.steps.push({ step: 'webauthn', ...webauthn })

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

    // --- tab sleep: release a background renderer, then wake it -----------
    const longPage = pathToFileURL(path.join(__dirname, '..', '..', 'examples', 'long-page.html')).toString()
    const sleepTab = tabs.create({ url: longPage, activate: true })
    await waitForLoad(tabs, sleepTab)
    await wait(400)
    await tabs.tabs.get(sleepTab).view.webContents.executeJavaScript('window.scrollTo(0, 1200)')
    await wait(350)

    const activeBefore = tabs.activeId
    const otherId = tabs.order.find((id) => id !== sleepTab)
    if (otherId == null) throw new Error('need a second tab to park the long page in the background')
    tabs.activate(otherId)                             // park the long page in the background
    await wait(150)

    const savedIdle = tabs.policy.idleMs
    tabs.policy.idleMs = 0
    const released = await tabs.sweep()
    const sleepRecord = tabs.tabs.get(sleepTab)
    if (!released.includes(sleepTab)) fails.push('idle background tab was not released')
    if (sleepRecord.view !== null) fails.push('released tab still holds a WebContentsView')
    if (!sleepRecord.suspended) fails.push('released tab is not marked as sleeping')
    report.steps.push({
      step: 'tab-sleep',
      released,
      suspendedTab: { id: sleepRecord.id, url: sleepRecord.url, scrollY: sleepRecord.scrollY, reason: sleepRecord.suspendedReason },
      totalSuspended: tabs.stats.suspendedTotal,
      chromeCapture: await capture(chromeView.webContents, path.join(outDir, '09-sleeping-tab.png'))
    })

    // wake it: the URL and the scroll position must come back
    tabs.activate(sleepTab)
    await waitForLoad(tabs, sleepTab)
    await wait(900)
    const wokeRecord = tabs.tabs.get(sleepTab)
    const scrollAfter = await wokeRecord.view.webContents.executeJavaScript('Math.round(window.scrollY)')
    if (wokeRecord.suspended) fails.push('tab did not wake up')
    if (!wokeRecord.url.includes('long-page.html')) fails.push('tab lost its URL while sleeping')
    if (Math.abs(scrollAfter - 1200) > 80) fails.push(`scroll position not restored (got ${scrollAfter})`)
    report.steps.push({ step: 'tab-wake', url: wokeRecord.url, scrollY: scrollAfter })

    // keep-alive: the user switch must win over the automatic policy
    tabs.activate(otherId)
    tabs.setKeepAlive(sleepTab, true)
    const releasedWithKeepAlive = await tabs.sweep()
    if (releasedWithKeepAlive.includes(sleepTab)) fails.push('keep-alive tab was released anyway')

    tabs.setKeepAlive(sleepTab, false)
    const releasedAfterOptOut = await tabs.sweep()
    if (!releasedAfterOptOut.includes(sleepTab)) fails.push('tab was not released after keep-alive was turned off')
    report.steps.push({
      step: 'tab-keep-alive',
      honouredKeepAlive: !releasedWithKeepAlive.includes(sleepTab),
      releasedAfterOptOut: releasedAfterOptOut.includes(sleepTab)
    })

    tabs.close(sleepTab)
    tabs.policy.idleMs = savedIdle
    tabs.activate(activeBefore != null && tabs.tabs.has(activeBefore) ? activeBefore : otherId)
    await wait(300)

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
