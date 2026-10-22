// MonkTrades Chrome Extension Background Service Worker (Manifest V3)
// Enforces server-authoritative Trading Firewall lockouts on Kite Zerodha and Angel One.

const ALARM_NAME = 'trading_firewall_poll';
const DEFAULT_ZERODHA_ACCOUNT = 'acc_mt_zerodha_default';
const DEFAULT_ANGELONE_ACCOUNT = 'acc_mt_angelone_default';

// 1. Setup periodic alarm using chrome.alarms (MV3 lifecycle safe with persistAcrossSessions)
if (typeof chrome !== 'undefined' && chrome.alarms) {
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: 0.5, persistAcrossSessions: true });

  chrome.runtime.onInstalled.addListener(() => {
    chrome.alarms.create(ALARM_NAME, { periodInMinutes: 0.5, persistAcrossSessions: true });
  });

  chrome.runtime.onStartup.addListener(() => {
    chrome.alarms.create(ALARM_NAME, { periodInMinutes: 0.5, persistAcrossSessions: true });
  });

  // Periodic alarm handler: inspect active/open tabs and enforce lockout across both brokers
  chrome.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm && alarm.name === ALARM_NAME) {
      await checkAndEnforceActiveTabs();
    }
  });
}

// 2. Broker URL Classification Helpers
function isKiteDomain(urlObj) {
  if (!urlObj || !urlObj.hostname) return false;
  return urlObj.hostname === 'kite.zerodha.com';
}

function isAngelOneDomain(urlObj) {
  if (!urlObj || !urlObj.hostname) return false;
  const h = urlObj.hostname.toLowerCase();
  return h === 'angelone.in' || h === 'www.angelone.in' || h === 'trade.angelone.in' || h.endsWith('.angelone.in');
}

function isAngelOneUnprotectedUrl(urlObj) {
  if (!urlObj) return false;
  const pathname = (urlObj.pathname || '').toLowerCase();

  // Authentication, Login, MPIN, OTP, & Demat Onboarding must NEVER be blocked
  if (
    pathname.startsWith('/login') ||
    pathname.startsWith('/signin') ||
    pathname.startsWith('/auth') ||
    pathname.startsWith('/otp') ||
    pathname.startsWith('/mpin') ||
    pathname.startsWith('/register') ||
    pathname.startsWith('/open-demat-account') ||
    pathname.startsWith('/forgot-pin') ||
    pathname.startsWith('/reset-password')
  ) {
    return true;
  }

  // Public Informational, Educational, Research & Marketing Pages on angelone.in / www.angelone.in
  const h = (urlObj.hostname || '').toLowerCase();
  if (h !== 'trade.angelone.in') {
    if (
      pathname === '/' ||
      pathname === '' ||
      pathname.startsWith('/knowledge-center') ||
      pathname.startsWith('/support') ||
      pathname.startsWith('/about-us') ||
      pathname.startsWith('/blogs') ||
      pathname.startsWith('/news') ||
      pathname.startsWith('/pricing') ||
      pathname.startsWith('/mutual-funds') ||
      pathname.startsWith('/ipo') ||
      pathname.startsWith('/calculators') ||
      pathname.startsWith('/contact-us') ||
      pathname.startsWith('/faq') ||
      pathname.startsWith('/privacy-policy') ||
      pathname.startsWith('/terms-and-conditions')
    ) {
      return true;
    }
  }

  return false;
}

function isAngelOneProtectedUrl(urlObj) {
  if (!isAngelOneDomain(urlObj)) return false;
  if (isAngelOneUnprotectedUrl(urlObj)) return false;

  // trade.angelone.in is the dedicated trading portal
  const h = (urlObj.hostname || '').toLowerCase();
  if (h === 'trade.angelone.in') {
    return true;
  }

  // Trading sections on www.angelone.in / angelone.in
  const pathname = (urlObj.pathname || '').toLowerCase();
  const tradingPaths = [
    '/trade',
    '/trading',
    '/watchlist',
    '/orders',
    '/order',
    '/portfolio',
    '/positions',
    '/option-chain',
    '/fno',
    '/holdings',
    '/charts',
    '/analytics'
  ];

  return tradingPaths.some((p) => pathname.startsWith(p));
}

// 3. Intercept new navigations via webNavigation.onBeforeNavigate
if (typeof chrome !== 'undefined' && chrome.webNavigation && chrome.webNavigation.onBeforeNavigate) {
  chrome.webNavigation.onBeforeNavigate.addListener(async (details) => {
    if (details.frameId !== 0) return;
    try {
      const url = new URL(details.url);

      // Zerodha Kite Navigation Check
      if (isKiteDomain(url)) {
        const isLocked = await checkTradingFirewallStatus('zerodha', DEFAULT_ZERODHA_ACCOUNT);
        if (isLocked) {
          const blockedUrl = chrome.runtime.getURL('blocked.html') + 
            '?url=' + encodeURIComponent(details.url) +
            '&broker=zerodha&account=' + encodeURIComponent(DEFAULT_ZERODHA_ACCOUNT);
          chrome.tabs.update(details.tabId, { url: blockedUrl });
        }
        return;
      }

      // Angel One Navigation Check (Protected Trading Actions only)
      if (isAngelOneProtectedUrl(url)) {
        const isLocked = await checkTradingFirewallStatus('angelone', DEFAULT_ANGELONE_ACCOUNT);
        if (isLocked) {
          const blockedUrl = chrome.runtime.getURL('blocked.html') + 
            '?url=' + encodeURIComponent(details.url) +
            '&broker=angelone&account=' + encodeURIComponent(DEFAULT_ANGELONE_ACCOUNT);
          chrome.tabs.update(details.tabId, { url: blockedUrl });
        }
      }
    } catch (err) {
      // Ignore invalid URLs
    }
  });

  // Intercept client-side SPA route transitions on Angel One
  if (chrome.webNavigation.onHistoryStateUpdated) {
    chrome.webNavigation.onHistoryStateUpdated.addListener(async (details) => {
      if (details.frameId !== 0) return;
      try {
        const url = new URL(details.url);
        if (isAngelOneProtectedUrl(url)) {
          const isLocked = await checkTradingFirewallStatus('angelone', DEFAULT_ANGELONE_ACCOUNT);
          if (isLocked) {
            const blockedUrl = chrome.runtime.getURL('blocked.html') + 
              '?url=' + encodeURIComponent(details.url) +
              '&broker=angelone&account=' + encodeURIComponent(DEFAULT_ANGELONE_ACCOUNT);
            chrome.tabs.update(details.tabId, { url: blockedUrl });
          }
        }
      } catch (err) {
        // Ignore invalid URLs
      }
    });
  }
}

// 4. Check and enforce lockout across all existing open tabs
async function checkAndEnforceActiveTabs() {
  if (typeof chrome === 'undefined' || !chrome.tabs) return;

  const [isZerodhaLocked, isAngelOneLocked] = await Promise.all([
    checkTradingFirewallStatus('zerodha', DEFAULT_ZERODHA_ACCOUNT),
    checkTradingFirewallStatus('angelone', DEFAULT_ANGELONE_ACCOUNT)
  ]);

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

          // Enforce Zerodha Kite Tabs
          if (isKiteDomain(url) && isZerodhaLocked) {
            const blockedUrl = chrome.runtime.getURL('blocked.html') + 
              '?url=' + encodeURIComponent(tab.url) +
              '&broker=zerodha&account=' + encodeURIComponent(DEFAULT_ZERODHA_ACCOUNT);
            chrome.tabs.update(tab.id, { url: blockedUrl });
          }

          // Enforce Angel One Protected Trading Tabs
          if (isAngelOneProtectedUrl(url) && isAngelOneLocked) {
            const blockedUrl = chrome.runtime.getURL('blocked.html') + 
              '?url=' + encodeURIComponent(tab.url) +
              '&broker=angelone&account=' + encodeURIComponent(DEFAULT_ANGELONE_ACCOUNT);
            chrome.tabs.update(tab.id, { url: blockedUrl });
          }
        } catch (e) {
          // Ignore invalid tab URLs
        }
      }
      resolve();
    });
  });
}

// 5. Authoritative risk contract evaluation with strict fail-closed guarantees & account isolation
async function checkTradingFirewallStatus(broker = 'zerodha', accountId = undefined) {
  const targetBroker = broker === 'angelone' ? 'angelone' : 'zerodha';
  const targetAccountId = accountId || (targetBroker === 'angelone' ? DEFAULT_ANGELONE_ACCOUNT : DEFAULT_ZERODHA_ACCOUNT);

  return new Promise((resolve) => {
    if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) {
      resolve(false);
      return;
    }

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

      // PAIRED State: Query the backend risk enforcement contract scoped to broker and account
      try {
        const queryStr = `broker=${encodeURIComponent(targetBroker)}&accountId=${encodeURIComponent(targetAccountId)}`;
        const response = await fetch(`${serverUrl}/api/enforcement/broker?${queryStr}`, {
          method: 'GET',
          headers: {
            'Content-Type': 'application/json',
            'x-user-id': userId,
            'x-extension-token': extensionToken,
            'x-broker': targetBroker,
            'x-account-id': targetAccountId
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
        // LOCKED: blocks trading actions for target broker
        // READY / ACTIVE: enforcement active -> blocks trading actions for target broker
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

// 6. Message handler for content scripts or popup queries
if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request && request.type === 'CHECK_LOCK_STATUS') {
      const broker = request.broker || 'zerodha';
      const accountId = request.accountId || (broker === 'angelone' ? DEFAULT_ANGELONE_ACCOUNT : DEFAULT_ZERODHA_ACCOUNT);

      checkTradingFirewallStatus(broker, accountId).then((isLocked) => {
        sendResponse({ isLocked, broker, accountId });
      });
      return true; // Keep channel open for async response
    }
  });
}

// Export for Node.js test environment
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    isKiteDomain,
    isAngelOneDomain,
    isAngelOneUnprotectedUrl,
    isAngelOneProtectedUrl,
    checkTradingFirewallStatus,
    checkAndEnforceActiveTabs,
    DEFAULT_ZERODHA_ACCOUNT,
    DEFAULT_ANGELONE_ACCOUNT,
  };
}
