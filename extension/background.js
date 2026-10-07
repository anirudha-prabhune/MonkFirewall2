// MonkTrades Chrome Extension Background Service Worker (Manifest V3)

const ExtensionState = {
  UNPAIRED: 'UNPAIRED',
  PAIRED: 'PAIRED',
  LOCKED: 'LOCKED',
  RELEASED: 'RELEASED'
};

// Listen to webNavigation onBeforeNavigate to intercept and block trade screens
chrome.webNavigation.onBeforeNavigate.addListener(async (details) => {
  if (details.frameId !== 0) return;
  const url = new URL(details.url);
  if (!url.hostname.includes('kite.zerodha.com')) return;

  const isLocked = await checkTradingFirewallStatus();
  if (isLocked) {
    const blockedUrl = chrome.runtime.getURL('blocked.html') + '?url=' + encodeURIComponent(details.url);
    chrome.tabs.update(details.tabId, { url: blockedUrl });
  }
});

// Helper to query the authoritative risk enforcement contract
async function checkTradingFirewallStatus() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['userId', 'extensionToken', 'serverUrl', 'pairingState', 'lastKnownState'], async (data) => {
      const { userId, extensionToken, serverUrl, pairingState, lastKnownState } = data;

      // 1. UNPAIRED State: If the extension has never been paired, allow passive default access
      if (pairingState !== 'PAIRED') {
        console.log('[MonkTrades Extension] UNPAIRED State. Access permitted passively.');
        resolve(false);
        return;
      }

      // 2. PAIRED State check: Once the browser extension is explicitly paired, missing/invalid MonkTrades session/credentials
      // must NOT silently allow Zerodha. Fail-closed safeguard is strictly applied.
      if (!userId || !serverUrl) {
        console.warn('[MonkTrades Extension] PAIRED State but missing userId or serverUrl. Fail-closed applied.');
        resolve(true);
        return;
      }

      // 3. PAIRED State Query: Query the backend using the cryptographic signature token.
      try {
        const response = await fetch(`${serverUrl}/api/enforcement/broker`, {
          method: 'GET',
          headers: {
            'Content-Type': 'application/json',
            'x-user-id': userId,
            'x-extension-token': extensionToken || ''
          }
        });

        if (response.status === 401) {
          // Authentication failure or token invalidation -> Fail closed
          console.warn('[MonkTrades Extension] Authentication rejected by server (401). Fail-closed applied.');
          chrome.storage.local.set({ lastKnownState: 'LOCKED' });
          resolve(true);
          return;
        }

        if (!response.ok) {
          console.warn('[MonkTrades Extension] Server returned non-200 status. Fail-closed applied.');
          resolve(true);
          return;
        }

        const contract = await response.json();
        
        // Authoritative state check:
        // LOCKED: blocks kite.zerodha.com navigation
        // ALLOW / WARNING: releases navigation
        // MARKET_CLOSED: non-blocking inactive state (does NOT lock)
        const isLocked = Boolean(
          contract && (
            contract.riskState === 'LOCKED' ||
            contract.enforcementStatus === 'READY' ||
            contract.enforcementStatus === 'ACTIVE'
          )
        );
        
        if (isLocked) {
          chrome.storage.local.set({ lastKnownState: 'LOCKED' });
          resolve(true);
        } else {
          chrome.storage.local.set({ lastKnownState: 'RELEASED' });
          resolve(false);
        }
      } catch (err) {
        console.error('[MonkTrades Extension] Server unreachable or network error. Fail-closed applied.', err);
        // Requirement 1 & 2: After pairing, extension access MUST fail closed when the server cannot be reached.
        // Never allow Zerodha access merely because lastKnownState was RELEASED when the authoritative server state is unavailable.
        resolve(true);
      }
    });
  });
}

// Receive messages from content scripts to evaluate lock on demand
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === 'CHECK_LOCK_STATUS') {
    checkTradingFirewallStatus().then((isLocked) => {
      sendResponse({ isLocked });
    });
    return true; // Keep channel open for async response
  }
});
