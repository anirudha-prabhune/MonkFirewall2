import { strict as assert } from 'assert';
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { ServerRiskStore } from '../server/risk/store';
import { DEFAULT_RISK_CONFIG } from '../src/types/risk';
import { getTradingDateKolkata, RiskSession } from '../server/risk/engine';
import { generateExtensionToken } from '../server/enforcement/guard';
import { enableMockStoreForTesting } from '../server/brokers/zerodha/sessionStore';
import express from 'express';
import { apiRouter } from '../server/api';
import http from 'http';

async function runPhase12cExtensionE2ETestSuite() {
  console.log('================================================================');
  console.log('TRADING FIREWALL: PHASE 12C CHROME EXTENSION GENUINE E2E SUITE');
  console.log('Executing actual extension/background.js in Sandbox Environment');
  console.log('================================================================\n');

  enableMockStoreForTesting(true);
  ServerRiskStore.reset();

  const testUser = 'phase12c_e2e_user';
  const tradingDate = getTradingDateKolkata(new Date());

  // Spin up a live local HTTP server with real apiRouter
  const app = express();
  app.use('/api', apiRouter);
  const server = http.createServer(app);

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const address = server.address() as any;
  const serverUrl = `http://127.0.0.1:${address.port}`;

  // Initialize Risk Config
  await ServerRiskStore.saveConfig(testUser, {
    ...DEFAULT_RISK_CONFIG,
    dailyLossLimit: 1000,
    lockDurationMinutes: 120,
    enabled: true,
  });

  function injectSession(userId: string, session: RiskSession) {
    const storeState = (ServerRiskStore as any).getOrCreateUserState(userId);
    storeState.sessions.set(session.tradingDate, session);
  }

  // Load the actual background.js file
  const backgroundJsCode = fs.readFileSync(path.resolve('./extension/background.js'), 'utf-8');

  // Harness to instantiate background.js in a mock Chrome runtime
  function createExtensionHarness(initialStorage: Record<string, any> = {}) {
    const storageData = { ...initialStorage };
    let navigationListener: ((details: any) => Promise<void>) | null = null;
    let messageListener: ((request: any, sender: any, sendResponse: (res: any) => void) => boolean) | null = null;
    const tabUpdates: Array<{ tabId: number; updateProps: any }> = [];

    const mockChrome = {
      storage: {
        local: {
          get: (keys: string[], callback: (data: any) => void) => {
            const result: Record<string, any> = {};
            for (const key of keys) {
              if (key in storageData) {
                result[key] = storageData[key];
              }
            }
            setTimeout(() => callback(result), 0);
          },
          set: (items: Record<string, any>, callback?: () => void) => {
            Object.assign(storageData, items);
            if (callback) setTimeout(callback, 0);
          },
        },
      },
      webNavigation: {
        onBeforeNavigate: {
          addListener: (fn: (details: any) => Promise<void>) => {
            navigationListener = fn;
          },
        },
      },
      runtime: {
        getURL: (pathStr: string) => `chrome-extension://mock-id/${pathStr}`,
        onMessage: {
          addListener: (fn: any) => {
            messageListener = fn;
          },
        },
      },
      tabs: {
        update: (tabId: number, updateProps: any) => {
          tabUpdates.push({ tabId, updateProps });
        },
      },
    };

    const sandbox = {
      chrome: mockChrome,
      console,
      URL,
      encodeURIComponent,
      fetch,
      Promise,
      setTimeout,
    };

    const context = vm.createContext(sandbox);
    vm.runInContext(backgroundJsCode, context);

    return {
      storageData,
      tabUpdates,
      getNavigationListener: () => {
        assert.ok(navigationListener, 'onBeforeNavigate listener must be registered by background.js');
        return navigationListener!;
      },
      getMessageListener: () => {
        assert.ok(messageListener, 'onMessage listener must be registered by background.js');
        return messageListener!;
      },
      clearUpdates: () => {
        tabUpdates.length = 0;
      },
    };
  }

  const validToken = generateExtensionToken(testUser);

  try {
    // --------------------------------------------------------------------------
    // E2E TEST 1: UNPAIRED state allows Zerodha navigation passively
    // --------------------------------------------------------------------------
    console.log('[E2E Test 1] UNPAIRED state allows Zerodha navigation passively');
    {
      const harness = createExtensionHarness({ pairingState: 'UNPAIRED' });
      const nav = harness.getNavigationListener();
      await nav({ frameId: 0, tabId: 101, url: 'https://kite.zerodha.com/dashboard' });

      assert.equal(harness.tabUpdates.length, 0, 'UNPAIRED state must NOT block Zerodha');
      console.log('  ✓ PASSED: UNPAIRED state leaves Zerodha unrestricted');
    }

    // --------------------------------------------------------------------------
    // E2E TEST 2: PAIRED + LOCKED blocks kite.zerodha.com navigation
    // --------------------------------------------------------------------------
    console.log('\n[E2E Test 2] PAIRED + LOCKED blocks kite.zerodha.com navigation');
    {
      // Inject LOCKED RiskSession in server store
      const lockedSession: RiskSession = {
        tradingDate,
        userId: testUser,
        state: 'LOCKED',
        isBreached: true,
        currentPnl: -1200,
        realisedPnl: -1200,
        unrealisedPnl: 0,
        lossLimit: 1000,
        warningThreshold1: 70,
        warningThreshold2: 90,
        lastEvaluatedAt: new Date().toISOString(),
        lockedAt: new Date().toISOString(),
        lockUntil: new Date(Date.now() + 3600 * 1000).toISOString(),
        reason: 'Daily loss limit breached',
      };
      injectSession(testUser, lockedSession);

      const harness = createExtensionHarness({
        pairingState: 'PAIRED',
        userId: testUser,
        extensionToken: validToken,
        serverUrl,
        lastKnownState: 'RELEASED',
      });

      const nav = harness.getNavigationListener();
      await nav({ frameId: 0, tabId: 102, url: 'https://kite.zerodha.com/orders' });

      assert.equal(harness.tabUpdates.length, 1, 'LOCKED state must intercept navigation');
      assert.equal(harness.tabUpdates[0].tabId, 102);
      assert.ok(
        harness.tabUpdates[0].updateProps.url.includes('blocked.html?url=https%3A%2F%2Fkite.zerodha.com%2Forders'),
        'Redirects to blocked.html with encoded URL'
      );
      assert.equal(harness.storageData.lastKnownState, 'LOCKED', 'Updates storage to LOCKED');
      console.log('  ✓ PASSED: LOCKED state actively redirects kite.zerodha.com to blocked.html');
    }

    // --------------------------------------------------------------------------
    // E2E TEST 3: PAIRED + ALLOW releases kite.zerodha.com navigation
    // --------------------------------------------------------------------------
    console.log('\n[E2E Test 3] PAIRED + ALLOW releases kite.zerodha.com navigation');
    {
      const allowSession: RiskSession = {
        tradingDate,
        userId: testUser,
        state: 'ALLOW',
        isBreached: false,
        currentPnl: 500,
        realisedPnl: 500,
        unrealisedPnl: 0,
        lossLimit: 1000,
        warningThreshold1: 70,
        warningThreshold2: 90,
        lastEvaluatedAt: new Date().toISOString(),
        lockedAt: null,
        lockUntil: null,
        reason: 'Normal',
      };
      injectSession(testUser, allowSession);

      const harness = createExtensionHarness({
        pairingState: 'PAIRED',
        userId: testUser,
        extensionToken: validToken,
        serverUrl,
        lastKnownState: 'LOCKED',
      });

      const nav = harness.getNavigationListener();
      await nav({ frameId: 0, tabId: 103, url: 'https://kite.zerodha.com/holdings' });

      assert.equal(harness.tabUpdates.length, 0, 'ALLOW state must NOT block Zerodha');
      assert.equal(harness.storageData.lastKnownState, 'RELEASED', 'Updates storage to RELEASED');
      console.log('  ✓ PASSED: ALLOW state releases Zerodha navigation');
    }

    // --------------------------------------------------------------------------
    // E2E TEST 4: PAIRED + WARNING releases kite.zerodha.com navigation
    // --------------------------------------------------------------------------
    console.log('\n[E2E Test 4] PAIRED + WARNING releases kite.zerodha.com navigation');
    {
      const warnSession: RiskSession = {
        tradingDate,
        userId: testUser,
        state: 'WARNING',
        isBreached: false,
        currentPnl: -750,
        realisedPnl: -750,
        unrealisedPnl: 0,
        lossLimit: 1000,
        warningThreshold1: 70,
        warningThreshold2: 90,
        lastEvaluatedAt: new Date().toISOString(),
        lockedAt: null,
        lockUntil: null,
        reason: 'Threshold warning',
      };
      injectSession(testUser, warnSession);

      const harness = createExtensionHarness({
        pairingState: 'PAIRED',
        userId: testUser,
        extensionToken: validToken,
        serverUrl,
        lastKnownState: 'RELEASED',
      });

      const nav = harness.getNavigationListener();
      await nav({ frameId: 0, tabId: 104, url: 'https://kite.zerodha.com/positions' });

      assert.equal(harness.tabUpdates.length, 0, 'WARNING state must NOT block Zerodha');
      assert.equal(harness.storageData.lastKnownState, 'RELEASED');
      console.log('  ✓ PASSED: WARNING state permits trading navigation');
    }

    // --------------------------------------------------------------------------
    // E2E TEST 5: PAIRED + MARKET_CLOSED does NOT trigger lock
    // --------------------------------------------------------------------------
    console.log('\n[E2E Test 5] PAIRED + MARKET_CLOSED does NOT trigger lock');
    {
      const closedSession: RiskSession = {
        tradingDate,
        userId: testUser,
        state: 'MARKET_CLOSED',
        isBreached: false,
        currentPnl: 0,
        realisedPnl: 0,
        unrealisedPnl: 0,
        lossLimit: 1000,
        warningThreshold1: 70,
        warningThreshold2: 90,
        lastEvaluatedAt: new Date().toISOString(),
        lockedAt: null,
        lockUntil: null,
        reason: 'Market closed',
      };
      injectSession(testUser, closedSession);

      const harness = createExtensionHarness({
        pairingState: 'PAIRED',
        userId: testUser,
        extensionToken: validToken,
        serverUrl,
        lastKnownState: 'RELEASED',
      });

      const nav = harness.getNavigationListener();
      await nav({ frameId: 0, tabId: 105, url: 'https://kite.zerodha.com/funds' });

      assert.equal(harness.tabUpdates.length, 0, 'MARKET_CLOSED state must NOT lock navigation');
      assert.equal(harness.storageData.lastKnownState, 'RELEASED');
      console.log('  ✓ PASSED: MARKET_CLOSED state is non-blocking');
    }

    // --------------------------------------------------------------------------
    // E2E TEST 6: After pairing, fails closed when server is unreachable
    // --------------------------------------------------------------------------
    console.log('\n[E2E Test 6] After pairing, fails closed when server is unreachable');
    {
      const deadServerUrl = 'http://127.0.0.1:1'; // Unreachable port
      const harness = createExtensionHarness({
        pairingState: 'PAIRED',
        userId: testUser,
        extensionToken: validToken,
        serverUrl: deadServerUrl,
        lastKnownState: 'RELEASED', // Even if last known state was clean!
      });

      const nav = harness.getNavigationListener();
      await nav({ frameId: 0, tabId: 106, url: 'https://kite.zerodha.com/dashboard' });

      assert.equal(harness.tabUpdates.length, 1, 'Unreachable server MUST fail closed and block Zerodha');
      assert.ok(harness.tabUpdates[0].updateProps.url.includes('blocked.html'));
      console.log('  ✓ PASSED: Unreachable server strictly fails closed after pairing');
    }

    // --------------------------------------------------------------------------
    // E2E TEST 7: Never allow Zerodha merely because lastKnownState was RELEASED when server is down
    // --------------------------------------------------------------------------
    console.log('\n[E2E Test 7] Never allow Zerodha merely because lastKnownState was RELEASED when server is down');
    {
      const deadServerUrl = 'http://127.0.0.1:1';
      const harness = createExtensionHarness({
        pairingState: 'PAIRED',
        userId: testUser,
        extensionToken: validToken,
        serverUrl: deadServerUrl,
        lastKnownState: 'RELEASED',
      });

      const msgListener = harness.getMessageListener();
      let responseResult: any = null;
      msgListener({ type: 'CHECK_LOCK_STATUS' }, {}, (res) => {
        responseResult = res;
      });

      // Wait for async response
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.ok(responseResult !== null, 'Message response received');
      assert.equal(responseResult.isLocked, true, 'isLocked must be TRUE (fail-closed) when server is down');
      console.log('  ✓ PASSED: lastKnownState RELEASED does not bypass offline fail-closed check');
    }

    // --------------------------------------------------------------------------
    // E2E TEST 8: MonkTrades dashboard is never blocked by the extension
    // --------------------------------------------------------------------------
    console.log('\n[E2E Test 8] MonkTrades dashboard is never blocked by the extension');
    {
      // Even under active LOCKED state
      const harness = createExtensionHarness({
        pairingState: 'PAIRED',
        userId: testUser,
        extensionToken: validToken,
        serverUrl,
        lastKnownState: 'LOCKED',
      });

      const nav = harness.getNavigationListener();
      await nav({ frameId: 0, tabId: 108, url: 'http://localhost:3000/dashboard' });
      await nav({ frameId: 0, tabId: 108, url: 'https://ais-dev-preview.run.app/risk' });

      assert.equal(harness.tabUpdates.length, 0, 'MonkTrades URLs must NEVER be blocked');
      console.log('  ✓ PASSED: MonkTrades dashboard remains fully accessible under all states');
    }

    // --------------------------------------------------------------------------
    // E2E TEST 9: Tampered / Invalid Token fails closed (HTTP 401)
    // --------------------------------------------------------------------------
    console.log('\n[E2E Test 9] Tampered / Invalid Token fails closed (HTTP 401)');
    {
      const harness = createExtensionHarness({
        pairingState: 'PAIRED',
        userId: testUser,
        extensionToken: 'tampered_bad_token_123',
        serverUrl,
        lastKnownState: 'RELEASED',
      });

      const nav = harness.getNavigationListener();
      await nav({ frameId: 0, tabId: 109, url: 'https://kite.zerodha.com/dashboard' });

      assert.equal(harness.tabUpdates.length, 1, 'HTTP 401 must fail closed and block Zerodha');
      assert.ok(harness.tabUpdates[0].updateProps.url.includes('blocked.html'));
      console.log('  ✓ PASSED: Invalid token fails closed with blocked redirect');
    }

    // --------------------------------------------------------------------------
    // E2E TEST 10: Missing userId after pairing fails closed
    // --------------------------------------------------------------------------
    console.log('\n[E2E Test 10] Missing userId after pairing fails closed');
    {
      const harness = createExtensionHarness({
        pairingState: 'PAIRED',
        userId: undefined,
        extensionToken: undefined,
        serverUrl,
        lastKnownState: 'RELEASED',
      });

      const nav = harness.getNavigationListener();
      await nav({ frameId: 0, tabId: 110, url: 'https://kite.zerodha.com/dashboard' });

      assert.equal(harness.tabUpdates.length, 1, 'Missing userId after pairing must fail closed');
      assert.ok(harness.tabUpdates[0].updateProps.url.includes('blocked.html'));
      console.log('  ✓ PASSED: Missing userId after pairing strictly fails closed');
    }
  } finally {
    server.close();
  }

  console.log('\n================================================================');
  console.log('ALL 10 PHASE 12C CHROME EXTENSION E2E TESTS PASSED (10/10)');
  console.log('================================================================\n');
}

runPhase12cExtensionE2ETestSuite().catch((err) => {
  console.error('❌ PHASE 12C EXTENSION E2E TEST SUITE FAILED:', err);
  process.exit(1);
});
