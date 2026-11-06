// Runs on every http(s) page in the shell.
chrome.storage.local.get({ count: 0 }, (result) => {
  const count = (result && typeof result.count === 'number' ? result.count : 0) + 1
  chrome.storage.local.set({ count })

  const banner = document.createElement('div')
  banner.id = 'browser-shell-sample-banner'
  banner.textContent = 'Sample extension ran here · storage.count = ' + count
  Object.assign(banner.style, {
    position: 'fixed',
    left: '12px',
    bottom: '12px',
    zIndex: '2147483647',
    padding: '8px 12px',
    borderRadius: '8px',
    background: '#1a73e8',
    color: '#fff',
    font: '600 12px system-ui, -apple-system, sans-serif',
    boxShadow: '0 2px 10px rgba(0,0,0,0.35)',
    pointerEvents: 'none'
  })
  document.documentElement.appendChild(banner)

  try {
    chrome.runtime.sendMessage({ type: 'banner-shown', count }, () => void chrome.runtime.lastError)
  } catch (_) { /* background page may not be there */ }
})
