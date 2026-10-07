# Chrome Extension Deployment Guide

This guide explains how to install, configure, verify, and test the MonkTrades Trading Firewall Manifest V3 extension in Google Chrome.

---

## 1. Build and Export Extension Files

The extension source files reside in the `/extension` directory:
- `manifest.json`: Manifest V3 configuration with permissions and host match patterns.
- `background.js`: Service worker handling navigation interception, periodic alarm polling, and fail-closed lock evaluation.
- `content_monktrades.js`: Injected into MonkTrades to pair user credentials and server origin securely.
- `content_kite.js`: Injected into Kite Zerodha to check initial lock status.
- `blocked.html`: Lockout overlay displayed when daily risk limits are breached.
- `popup.html`: Extension status popup.

---

## 2. Load the Unpacked Extension in Chrome

1. Open Google Chrome and navigate to `chrome://extensions`.
2. Toggle **Developer mode** on (switch in the top-right corner).
3. Click **Load unpacked** (top-left button).
4. Select the `extension/` directory from this repository.
5. The **MonkTrades Trading Firewall Extension** will appear in the installed extensions list.

---

## 3. Exact MonkTrades Origin Configuration

Chrome Manifest V3 strictly validates URL match patterns. Middle wildcards (such as `https://ais-dev-*.run.app/*`) and broad wildcards (such as `https://*.run.app/*`) are disallowed or rejected by Chrome's match pattern specification.

The extension manifest is pre-configured with the exact established origins for this application:

- **Localhost Development Origins**:
  - `http://localhost:3000/*`
  - `http://127.0.0.1:3000/*`
  - `http://localhost/*`

- **Deployed Cloud Run MonkTrades Origins**:
  - `https://ais-dev-wyyezpv6s2lo3nusdgb6dl-608043296632.asia-southeast1.run.app/*`
  - `https://ais-pre-wyyezpv6s2lo3nusdgb6dl-608043296632.asia-southeast1.run.app/*`

- **Broker Host Permissions**:
  - `https://kite.zerodha.com/*` (minimized to exact Kite domain)

Both `host_permissions` and `content_scripts[0].matches` contain these exact origins so `content_monktrades.js` automatically pairs when navigating to either the local dev server or the deployed Cloud Run instance.

---

## 4. Pairing the Extension

1. Start and log in to the MonkTrades application in Chrome (via localhost or the deployed Cloud Run URL).
2. When the user session is authenticated, MonkTrades renders a pairing element (`monktrades-extension-sync`) containing the user ID and cryptographic extension token.
3. `content_monktrades.js` automatically pairs the extension and stores `userId`, `extensionToken`, and `serverUrl` in `chrome.storage.local`.
4. The extension transitions to the **PAIRED** state.

---

## 5. Active Tab and Navigation Enforcement on Kite

1. Open a new tab or navigate to `https://kite.zerodha.com`.
2. **ALLOW / WARNING / MARKET_CLOSED**:
   - Navigation proceeds normally. Open tabs remain unrestricted.
3. **LOCKED (Risk Limit Breached)**:
   - **New Navigation**: Intercepted by `webNavigation.onBeforeNavigate` and immediately redirected to `blocked.html`.
   - **Existing Open Tabs**: Polled periodically by `chrome.alarms` service worker task and automatically redirected to `blocked.html`.
4. **MonkTrades Protection**:
   - MonkTrades URLs are never blocked, allowing the trader to monitor risk status, view analytics, and adjust rules.
5. **Fail-Closed Safeguards**:
   - If the server is offline, credentials are missing, or token is invalid, the extension strictly fails closed and blocks Zerodha access until connection/authorization is restored.

---

## 6. Reloading After Manifest/Code Changes

Whenever you modify any file in `extension/` (such as `manifest.json` or `background.js`):
1. Navigate back to `chrome://extensions`.
2. Find **MonkTrades Trading Firewall Extension**.
3. Click the circular **Reload** icon on the extension card.
4. Refresh any open MonkTrades and Kite tabs to re-establish content scripts and listeners.
