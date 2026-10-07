// Content script injected into MonkTrades pages
(function() {
  const syncNode = document.getElementById('monktrades-extension-sync');
  if (syncNode) {
    const userId = syncNode.getAttribute('data-user-id');
    const extensionToken = syncNode.getAttribute('data-extension-token');
    const serverUrl = window.location.origin;

    if (userId && extensionToken) {
      chrome.storage.local.set({
        userId,
        extensionToken,
        serverUrl,
        pairingState: 'PAIRED'
      }, function() {
        console.log('[MonkTrades Extension] Explicitly paired with credentials and server URL:', { userId, serverUrl });
      });
    }
  }
})();
