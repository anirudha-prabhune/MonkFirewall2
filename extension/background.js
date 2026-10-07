// MonkTrades Chrome Extension Background Service Worker (Manifest V3)

const ALARM_NAME = 'trading_firewall_poll';

// 1. Setup periodic alarm using chrome.alarms (MV3 lifecycle safe with persistAcrossSessions)
chrome.alarms.create(ALARM_NAME, { periodInMinutes: 0.5, persistAcrossSessions: true });

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: 0.5, persistAcrossSessions: true });
});

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: 0.5, persistAcrossSessions: true });
});

// Periodic alarm handler: inspect active/open tabs and enforce lockout
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm && alarm.name === ALARM_NAME) {
    await checkAndEnforceActiveTabs();
  }
});

// 2. Intercept new navigations via webNavigation.onBeforeNavigate
chrome.webNavigation.onBeforeNavigate.addListener(async (details) => {
  if (details.frameId !== 0) return;
  try {
    const url = new URL(details.url);
    // Exact host matching: must match kite.zerodha.com exactly
    if (url.hostname !== 'kite.zerodha.com') return;

    const isLocked = await checkTradingFirewallStatus();
    if (isLocked) {
      const blockedUrl = chrome.runtime.getURL('blocked.html') + '?url=' + encodeURIComponent(details.url);
      chrome.tabs.update(details.tabId, { url: blockedUrl });
    }
  } catch (err) {
    // Ignore invalid URLs
  }
});

// 3. Check and enforce lockout across all existing open tabs
async function checkAndEnforceActiveTabs() {
  const isLocked = await checkTradingFirewallStatus();
  if (isLocked) {
    await redirectActiveKiteTabs();
  }
}

async function redirectActiveKiteTabs() {
  return new Promise((resolve) => {
    chrome.tabs.query({}, (tabs) => {
      if (!tabs || !Array.isArray(tabs)) {
        resolve();
        return;
      }
      for (const tab of tabs) {
        if (!tab.url || typeof tab.id !== 'number') continue;
        try {
          const url = new URL(tab.url);
          // Exact host matching: must match kite.zerodha.com exactly
          if (url.hostname === 'kite.zerodha.com') {
            const blockedUrl = chrome.runtime.getURL('blocked.html') + '?url=' + encodeURIComponent(tab.url);
            chrome.tabs.update(tab.id, { url: blockedUrl });
          }
        } catch (e) {
          // Ignore invalid URLs
        }
      }
      resolve();
    });
  });
}

// 4. Authoritative risk contract evaluation with strict fail-closed guarantees
async function checkTradingFirewallStatus() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['userId', 'extensionToken', 'serverUrl', 'pairingState'], async (data) => {
      const { userId, extensionToken, serverUrl, pairingState } = data || {};

      // UNPAIRED State: If extension is not paired, permit passive default access
      if (pairingState !== 'PAIRED') {
        resolve(false);
        return;
      }

      // PAIRED State: Missing credentials / tokens must fail-closed
      if (!userId || !serverUrl || !extensionToken) {
        chrome.storage.local.set({ lastKnownState: 'LOCKED' });
        resolve(true);
        return;
      }

      // PAIRED State: Query the backend risk enforcement contract
      try {
        const response = await fetch(`${serverUrl}/api/enforcement/broker`, {
          method: 'GET',
          headers: {
            'Content-Type': 'application/json',
            'x-user-id': userId,
            'x-extension-token': extensionToken
          }
        });

        if (response.status === 401 || response.status === 403) {
          // Authentication failure or token revocation -> Fail closed
          chrome.storage.local.set({ lastKnownState: 'LOCKED' });
          resolve(true);
          return;
        }

        if (!response.ok) {
          // Non-200 server response -> Fail closed
          chrome.storage.local.set({ lastKnownState: 'LOCKED' });
          resolve(true);
          return;
        }

        let contract;
        try {
          contract = await response.json();
        } catch (jsonErr) {
          // Malformed JSON -> Fail closed
          chrome.storage.local.set({ lastKnownState: 'LOCKED' });
          resolve(true);
          return;
        }

        if (!contract || typeof contract !== 'object') {
          // Malformed contract -> Fail closed
          chrome.storage.local.set({ lastKnownState: 'LOCKED' });
          resolve(true);
          return;
        }

        // Authoritative state evaluation:
        // LOCKED: blocks kite.zerodha.com
        // READY / ACTIVE: enforcement active -> blocks kite.zerodha.com
        // ALLOW / WARNING / MARKET_CLOSED: does not lock
        const isLocked = Boolean(
          contract.riskState === 'LOCKED' ||
          contract.enforcementStatus === 'READY' ||
          contract.enforcementStatus === 'ACTIVE'
        );

        if (isLocked) {
          chrome.storage.local.set({ lastKnownState: 'LOCKED' });
          resolve(true);
        } else {
          chrome.storage.local.set({ lastKnownState: 'RELEASED' });
          resolve(false);
        }
      } catch (err) {
        // Network error / server unreachable / offline -> Fail closed
        chrome.storage.local.set({ lastKnownState: 'LOCKED' });
        resolve(true);
      }
    });
  });
}

// 5. Message handler for content scripts or popup queries
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request && request.type === 'CHECK_LOCK_STATUS') {
    checkTradingFirewallStatus().then((isLocked) => {
      sendResponse({ isLocked });
    });
    return true; // Keep channel open for async response
  }
});
