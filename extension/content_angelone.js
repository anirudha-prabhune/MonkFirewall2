// ArthaKavach Chrome Extension — Dedicated Content Script for Angel One (Manifest V3)
// Scoped strictly to acc_mt_angelone_default with server-authoritative lock enforcement.

(function() {
  if (typeof window === 'undefined') return;
  if (window.__monk_angelone_content_script_active) {
    return;
  }
  window.__monk_angelone_content_script_active = true;

  const BROKER = 'angelone';
  const ACCOUNT_ID = 'acc_mt_angelone_default';

  // 1. URL Classification Helpers: Distinguish Protected Trading Actions from Unrelated Browsing/Login
  function isUnprotectedUrl(urlObj) {
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
    if (urlObj.hostname !== 'trade.angelone.in') {
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

  function isProtectedTradingPage(urlObj) {
    if (isUnprotectedUrl(urlObj)) return false;

    // Dedicated Angel One web trading platform subdomain
    if (urlObj.hostname === 'trade.angelone.in') {
      return true;
    }

    // Trading sections and active panels on www.angelone.in / angelone.in
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

    return tradingPaths.some(p => pathname.startsWith(p));
  }

  // 2. Lockout Redirection Action
  function redirectToBlockedPage(targetUrl) {
    try {
      const blockedUrl = chrome.runtime.getURL('blocked.html') + 
        '?url=' + encodeURIComponent(targetUrl || window.location.href) +
        '&broker=' + encodeURIComponent(BROKER) +
        '&account=' + encodeURIComponent(ACCOUNT_ID);

      // Prevent infinite redirect loops if already on blocked.html
      if (!window.location.href.includes('blocked.html')) {
        window.location.href = blockedUrl;
      }
    } catch (err) {
      console.warn('[ArthaKavach AngelOne] Redirection failed:', err);
    }
  }

  // 3. Query Server-Authoritative Lock Status via Extension Background Service Worker
  let isCheckingLock = false;
  let lastCheckedTime = 0;
  let cachedLockState = null;

  function checkLockStatus(callback) {
    const now = Date.now();
    // Throttle queries to avoid excessive messaging during rapid DOM mutations (2s cache window)
    if (cachedLockState !== null && (now - lastCheckedTime < 2000)) {
      if (callback) callback(cachedLockState);
      return;
    }

    if (isCheckingLock) return;
    isCheckingLock = true;

    try {
      chrome.runtime.sendMessage(
        {
          type: 'CHECK_LOCK_STATUS',
          broker: BROKER,
          accountId: ACCOUNT_ID
        },
        (response) => {
          isCheckingLock = false;
          lastCheckedTime = Date.now();
          if (chrome.runtime.lastError) {
            // Service worker restarting or background channel busy
            return;
          }
          const isLocked = Boolean(response && response.isLocked);
          cachedLockState = isLocked;
          if (callback) callback(isLocked);
        }
      );
    } catch (e) {
      isCheckingLock = false;
    }
  }

  // 4. Initial Check on Page Load
  function evaluateCurrentPage() {
    try {
      const currentUrl = new URL(window.location.href);
      if (isProtectedTradingPage(currentUrl)) {
        checkLockStatus((isLocked) => {
          if (isLocked) {
            redirectToBlockedPage(currentUrl.href);
          }
        });
      }
    } catch (e) {
      // Ignore invalid URL parsing
    }
  }

  evaluateCurrentPage();

  // 5. Safe SPA Navigation Interception (pushState, replaceState, popstate, hashchange)
  function handleUrlChange() {
    evaluateCurrentPage();
  }

  window.addEventListener('popstate', handleUrlChange);
  window.addEventListener('hashchange', handleUrlChange);

  if (!history.__monk_angelone_patched) {
    history.__monk_angelone_patched = true;
    const origPushState = history.pushState;
    history.pushState = function() {
      const res = origPushState.apply(this, arguments);
      handleUrlChange();
      return res;
    };

    const origReplaceState = history.replaceState;
    history.replaceState = function() {
      const res = origReplaceState.apply(this, arguments);
      handleUrlChange();
      return res;
    };
  }

  // 6. Dedicated Angel One DOM Order-Pad & Buy/Sell Modal Detection
  // Angel One SmartAPI and Trade Web use specific component markers for order entry.
  // We do not reuse Kite DOM selectors; instead we detect Angel One order pads.
  const ANGEL_ORDER_PAD_SELECTORS = [
    'div[data-component="OrderPad"]',
    'div[data-testid="order-pad"]',
    'div[data-testid="orderpad"]',
    'div.order-pad',
    'div.orderpad',
    'div.order-placement',
    'div.buy-sell-modal',
    '#orderpad',
    'form[name="orderForm"]',
    'div[class*="OrderPad"]',
    'div[class*="order-pad"]',
    'div[class*="BuySellModal"]'
  ];

  function detectOrderPad() {
    for (const sel of ANGEL_ORDER_PAD_SELECTORS) {
      const el = document.querySelector(sel);
      if (el && el.offsetParent !== null) {
        return el;
      }
    }
    return null;
  }

  let mutationDebounceTimer = null;
  const domObserver = new MutationObserver(() => {
    if (mutationDebounceTimer) return;
    mutationDebounceTimer = setTimeout(() => {
      mutationDebounceTimer = null;
      const orderPad = detectOrderPad();
      if (orderPad) {
        checkLockStatus((isLocked) => {
          if (isLocked) {
            redirectToBlockedPage();
          }
        });
      }
    }, 250);
  });

  if (document.body) {
    domObserver.observe(document.body, { childList: true, subtree: true });
  } else {
    document.addEventListener('DOMContentLoaded', () => {
      if (document.body) {
        domObserver.observe(document.body, { childList: true, subtree: true });
      }
    });
  }

  // Clean up observers on page unload
  window.addEventListener('beforeunload', () => {
    if (domObserver) domObserver.disconnect();
  });
})();
