// Content script injected into MonkTrades pages (Manifest V3)
(function() {
  let hasPaired = false;
  let lastPairedUserId = null;
  let lastPairedToken = null;
  let syncNodeObserver = null;
  let documentObserver = null;

  function attemptPair(node) {
    if (!node) return false;
    const userId = node.getAttribute('data-user-id');
    const extensionToken = node.getAttribute('data-extension-token');
    const serverUrl = window.location.origin;

    if (userId && extensionToken && userId.trim() !== '' && extensionToken.trim() !== '') {
      // Avoid duplicate writes when the same credentials are already stored
      if (hasPaired && lastPairedUserId === userId && lastPairedToken === extensionToken) {
        return true;
      }

      hasPaired = true;
      lastPairedUserId = userId;
      lastPairedToken = extensionToken;

      chrome.storage.local.set({
        userId: userId.trim(),
        extensionToken: extensionToken.trim(),
        serverUrl,
        pairingState: 'PAIRED'
      }, function() {
        console.log('[MonkTrades Extension] Explicitly paired with credentials and server URL:', {
          userId: userId.trim(),
          serverUrl
        });
      });

      // Safely disconnect observers after successful pairing
      if (syncNodeObserver) {
        syncNodeObserver.disconnect();
        syncNodeObserver = null;
      }
      if (documentObserver) {
        documentObserver.disconnect();
        documentObserver = null;
      }
      return true;
    }
    return false;
  }

  function observeSyncNode(node) {
    if (!node) return;
    if (attemptPair(node)) return;

    if (!syncNodeObserver) {
      syncNodeObserver = new MutationObserver(function() {
        attemptPair(node);
      });
      syncNodeObserver.observe(node, {
        attributes: true,
        attributeFilter: ['data-user-id', 'data-extension-token']
      });
    }
  }

  // Check if sync node is already present in DOM
  const existingNode = document.getElementById('monktrades-extension-sync');
  if (existingNode) {
    observeSyncNode(existingNode);
  } else {
    // Sync node not present yet: observe document until the sync node appears
    documentObserver = new MutationObserver(function() {
      const node = document.getElementById('monktrades-extension-sync');
      if (node) {
        if (documentObserver) {
          documentObserver.disconnect();
          documentObserver = null;
        }
        observeSyncNode(node);
      }
    });

    const target = document.documentElement || document.body || document;
    if (target && target.nodeType === 1) {
      documentObserver.observe(target, {
        childList: true,
        subtree: true
      });
    }
  }
})();
