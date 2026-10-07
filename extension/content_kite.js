// Content script running on kite.zerodha.com
(function() {
  chrome.runtime.sendMessage({ type: 'CHECK_LOCK_STATUS' }, (response) => {
    if (response && response.isLocked) {
      window.location.href = chrome.runtime.getURL('blocked.html') + '?url=' + encodeURIComponent(window.location.href);
    }
  });
})();
