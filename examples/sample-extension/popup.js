chrome.storage.local.get({ count: 0, lastBannerAt: 0 }, (result) => {
  document.getElementById('count').textContent = result.count || 0
  document.getElementById('last').textContent = result.lastBannerAt
    ? new Date(result.lastBannerAt).toLocaleTimeString()
    : '—'
})
