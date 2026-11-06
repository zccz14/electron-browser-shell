chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message && message.type === 'banner-shown') {
    chrome.storage.local.set({ lastBannerAt: Date.now(), lastCount: message.count })
  }
  sendResponse({ ok: true })
  return true
})
