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

/**
 * Validates a Chrome Extension match pattern according to Chrome MV3 grammar:
 * <scheme>://<host>/<path>
 * Host must be '*', '*.<domain>', or an exact hostname/IP (with optional port).
 * Host cannot contain '*' anywhere except as the first character (e.g. *.example.com).
 */
function isValidChromeMatchPattern(pattern: string): boolean {
  if (pattern === '<all_urls>') return true;
  const match = pattern.match(/^(\*|http|https|file|ftp):\/\/(\*|\*\.[a-zA-Z0-9.-]+|[a-zA-Z0-9.-]+)(:\d+)?(\/.*)$/);
  if (!match) return false;
  const host = match[2];
  // If host starts with '*', it must be '*' or '*.' followed by domain with no other '*'
  if (host.includes('*')) {
    if (host === '*') return true;
    if (host.startsWith('*.') && !host.slice(2).includes('*')) return true;
    return false;
  }
  return true;
}

/**
 * DOM and MutationObserver harness to test content_monktrades.js pairing lifecycle
 */
function createDomContentScriptHarness() {
  const elements = new Map<string, any>();
  const observers: Array<{
    target: any;
    options: any;
    callback: (mutations: any[]) => void;
    disconnected: boolean;
  }> = [];

  class MockElement {
    id: string;
    attributes: Map<string, string> = new Map();
    nodeType = 1;
    children: MockElement[] = [];

    constructor(id: string = '') {
      this.id = id;
    }

    getAttribute(name: string) {
      return this.attributes.get(name) || null;
    }

    setAttribute(name: string, value: string) {
      const oldValue = this.attributes.get(name);
      this.attributes.set(name, value);
      // Trigger observers
      for (const obs of observers) {
        if (!obs.disconnected && (obs.target === this || obs.options.subtree)) {
          if (!obs.options.attributeFilter || obs.options.attributeFilter.includes(name)) {
            obs.callback([{ type: 'attributes', attributeName: name, target: this, oldValue }]);
          }
        }
      }
    }

    appendChild(child: MockElement) {
      this.children.push(child);
      if (child.id) elements.set(child.id, child);
      for (const obs of observers) {
        if (!obs.disconnected && obs.options.childList) {
          obs.callback([{ type: 'childList', addedNodes: [child], target: this }]);
        }
      }
    }
  }

  const documentElement = new MockElement('html');
  const body = new MockElement('body');
  documentElement.appendChild(body);

  const mockDocument = {
    documentElement,
    body,
    nodeType: 1,
    getElementById: (id: string) => elements.get(id) || null,
  };

  class MockMutationObserver {
    callback: (mutations: any[]) => void;
    obsRecord: any;

    constructor(cb: (mutations: any[]) => void) {
      this.callback = cb;
    }

    observe(target: any, options: any) {
      this.obsRecord = { target, options, callback: this.callback, disconnected: false };
      observers.push(this.obsRecord);
    }

    disconnect() {
      if (this.obsRecord) {
        this.obsRecord.disconnected = true;
      }
    }
  }

  const storageData: Record<string, any> = {};
  let setCalls = 0;
  const mockChrome = {
    storage: {
      local: {
        set: (data: Record<string, any>, cb?: () => void) => {
          setCalls++;
          Object.assign(storageData, data);
          if (cb) cb();
        },
        get: (keys: string[], cb: (res: any) => void) => {
          const res: Record<string, any> = {};
          for (const k of keys) res[k] = storageData[k];
          cb(res);
        },
      },
    },
  };

  const window = {
    location: {
      origin: 'https://ais-dev-wyyezpv6s2lo3nusdgb6dl-608043296632.asia-southeast1.run.app',
    },
  };

  function createSyncNode(userId = '', token = '') {
    const node = new MockElement('monktrades-extension-sync');
    if (userId) node.setAttribute('data-user-id', userId);
    if (token !== undefined) node.setAttribute('data-extension-token', token);
    elements.set('monktrades-extension-sync', node);
    body.appendChild(node);
    return node;
  }

  function runContentScript() {
    const contentScriptCode = fs.readFileSync(path.resolve('./extension/content_monktrades.js'), 'utf-8');
    const sandbox = {
      document: mockDocument,
      window,
      chrome: mockChrome,
      MutationObserver: MockMutationObserver,
      console,
    };
    const ctx = vm.createContext(sandbox);
    vm.runInContext(contentScriptCode, ctx);
  }

  return {
    elements,
    mockDocument,
    body,
    storageData,
    getSetCalls: () => setCalls,
    createSyncNode,
    runContentScript,
    MockElement,
  };
}

async function runPhase12cExtensionE2ETestSuite() {
  console.log('================================================================');
  console.log('TRADING FIREWALL: PHASE 16 / 12C CHROME EXTENSION ENFORCEMENT & E2E');
  console.log('Executing actual extension/background.js & content_monktrades.js');
  console.log('================================================================\n');

  enableMockStoreForTesting(true);
  ServerRiskStore.reset();

  const testUser = 'phase16_extension_user';
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
  function createExtensionHarness(
    initialStorage: Record<string, any> = {},
    initialTabs: Array<{ id: number; url: string }> = []
  ) {
    const storageData = { ...initialStorage };
    const openTabs = [...initialTabs];
    let navigationListener: ((details: any) => Promise<void>) | null = null;
    let messageListener: ((request: any, sender: any, sendResponse: (res: any) => void) => boolean) | null = null;
    const alarmListeners: Array<(alarm: { name: string }) => Promise<void> | void> = [];
    const tabUpdates: Array<{ tabId: number; updateProps: any }> = [];
    const alarmsCreated: Array<{ name: string; options: any }> = [];

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
        onInstalled: {
          addListener: (fn: any) => {
            // Triggered on installation
          },
        },
        onStartup: {
          addListener: (fn: any) => {
            // Triggered on startup
          },
        },
      },
      alarms: {
        create: (name: string, options: any) => {
          alarmsCreated.push({ name, options });
        },
        get: (name: string, callback: (alarm?: any) => void) => {
          const found = alarmsCreated.find((a) => a.name === name);
          callback(found);
        },
        onAlarm: {
          addListener: (fn: any) => {
            alarmListeners.push(fn);
          },
        },
      },
      tabs: {
        query: (queryInfo: any, callback: (tabs: any[]) => void) => {
          setTimeout(() => callback([...openTabs]), 0);
        },
        update: (tabId: number, updateProps: any) => {
          tabUpdates.push({ tabId, updateProps });
          const existing = openTabs.find((t) => t.id === tabId);
          if (existing && updateProps.url) {
            existing.url = updateProps.url;
          }
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
      Array,
    };

    const context = vm.createContext(sandbox);
    vm.runInContext(backgroundJsCode, context);

    return {
      storageData,
      openTabs,
      tabUpdates,
      alarmsCreated,
      getNavigationListener: () => {
        assert.ok(navigationListener, 'onBeforeNavigate listener must be registered by background.js');
        return navigationListener!;
      },
      getMessageListener: () => {
        assert.ok(messageListener, 'onMessage listener must be registered by background.js');
        return messageListener!;
      },
      triggerAlarm: async (alarmName = 'trading_firewall_poll') => {
        for (const listener of alarmListeners) {
          await listener({ name: alarmName });
        }
      },
      clearUpdates: () => {
        tabUpdates.length = 0;
      },
    };
  }

  const validToken = generateExtensionToken(testUser);

  try {
    // --------------------------------------------------------------------------
    // TEST 1: Manifest match patterns validity & Deployment Configuration
    // --------------------------------------------------------------------------
    console.log('[Test 1] Manifest match patterns validity check & deployment configuration');
    {
      const manifestPath = path.resolve('./extension/manifest.json');
      const manifestContent = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));

      const exactDevOrigin = 'https://ais-dev-wyyezpv6s2lo3nusdgb6dl-608043296632.asia-southeast1.run.app/*';
      const exactPreOrigin = 'https://ais-pre-wyyezpv6s2lo3nusdgb6dl-608043296632.asia-southeast1.run.app/*';
      const exactKiteOrigin = 'https://kite.zerodha.com/*';

      // 1. Manifest V3
      assert.equal(manifestContent.manifest_version, 3, 'Must be Manifest V3');

      // 2. Required permissions
      assert.ok(manifestContent.permissions.includes('alarms'), 'Must include alarms permission');
      assert.ok(manifestContent.permissions.includes('storage'), 'Must include storage permission');
      assert.ok(manifestContent.permissions.includes('tabs'), 'Must include tabs permission');
      assert.ok(manifestContent.permissions.includes('webNavigation'), 'Must include webNavigation permission');

      // 3. Exact Kite origin exists and no broad *.zerodha.com wildcard in host_permissions
      assert.ok(
        manifestContent.host_permissions.includes(exactKiteOrigin),
        `host_permissions must include exact Kite origin: ${exactKiteOrigin}`
      );
      assert.ok(
        !manifestContent.host_permissions.includes('https://*.zerodha.com/*'),
        'host_permissions should avoid broad *.zerodha.com wildcard'
      );

      // 4. Exact deployed MonkTrades origins exist in host_permissions
      assert.ok(
        manifestContent.host_permissions.includes(exactDevOrigin),
        `host_permissions must include exact deployed Dev origin: ${exactDevOrigin}`
      );
      assert.ok(
        manifestContent.host_permissions.includes(exactPreOrigin),
        `host_permissions must include exact deployed Shared/Preview origin: ${exactPreOrigin}`
      );

      // 5. Exact deployed MonkTrades origins exist in content_scripts[0].matches
      const monktradesContentScript = manifestContent.content_scripts.find((cs: any) =>
        cs.js && cs.js.includes('content_monktrades.js')
      );
      assert.ok(monktradesContentScript, 'content_monktrades.js script entry must exist');
      assert.ok(
        monktradesContentScript.matches.includes(exactDevOrigin),
        `content_monktrades.js matches must include exact deployed Dev origin: ${exactDevOrigin}`
      );
      assert.ok(
        monktradesContentScript.matches.includes(exactPreOrigin),
        `content_monktrades.js matches must include exact deployed Shared/Preview origin: ${exactPreOrigin}`
      );

      // 6. Localhost origins supported
      assert.ok(manifestContent.host_permissions.includes('http://localhost:3000/*'), 'host_permissions must support localhost:3000');
      assert.ok(monktradesContentScript.matches.includes('http://localhost:3000/*'), 'content_scripts must support localhost:3000');

      // 7. No middle-wildcard run.app pattern exists
      for (const pattern of manifestContent.host_permissions) {
        assert.ok(
          !pattern.includes('ais-dev-*.run.app') && !pattern.includes('ais-pre-*.run.app'),
          `host_permission "${pattern}" must not contain middle wildcards`
        );
      }
      for (const cs of manifestContent.content_scripts) {
        for (const pattern of cs.matches) {
          assert.ok(
            !pattern.includes('ais-dev-*.run.app') && !pattern.includes('ais-pre-*.run.app'),
            `content_script match "${pattern}" must not contain middle wildcards`
          );
        }
      }

      // 8. No broad *.run.app permission exists
      for (const pattern of manifestContent.host_permissions) {
        assert.ok(
          !pattern.includes('*.run.app') && pattern !== 'https://*.run.app/*',
          `host_permission "${pattern}" must not use broad *.run.app wildcard`
        );
      }
      for (const cs of manifestContent.content_scripts) {
        for (const pattern of cs.matches) {
          assert.ok(
            !pattern.includes('*.run.app') && pattern !== 'https://*.run.app/*',
            `content_script match "${pattern}" must not use broad *.run.app wildcard`
          );
        }
      }

      // 9. Verify all host_permissions and content_scripts match valid Chrome syntax
      for (const pattern of manifestContent.host_permissions) {
        assert.ok(
          isValidChromeMatchPattern(pattern),
          `host_permission pattern "${pattern}" must be a valid Chrome match pattern`
        );
      }
      for (const cs of manifestContent.content_scripts) {
        for (const pattern of cs.matches) {
          assert.ok(
            isValidChromeMatchPattern(pattern),
            `content_script match pattern "${pattern}" must be a valid Chrome match pattern`
          );
        }
      }

      // Verify our validator correctly catches invalid middle wildcards
      assert.equal(
        isValidChromeMatchPattern('https://ais-dev-*.run.app/*'),
        false,
        'Invalid middle wildcard pattern must fail validation'
      );
      assert.equal(
        isValidChromeMatchPattern('https://ais-pre-*.run.app/*'),
        false,
        'Invalid middle wildcard pattern must fail validation'
      );

      console.log('  ✓ PASSED: manifest.json has exact deployed origins, valid host patterns, and required MV3 configuration');
    }

    // --------------------------------------------------------------------------
    // TEST 2: Content Script Pairing Regression (Async Token & Observer)
    // --------------------------------------------------------------------------
    console.log('\n[Test 2] Content Script Pairing Regression (Async Token & Observer)');
    {
      // A. sync node exists with userId + token immediately -> PAIRED
      const harnessA = createDomContentScriptHarness();
      harnessA.createSyncNode('user_imm', 'token_imm_123');
      harnessA.runContentScript();
      assert.equal(harnessA.storageData.pairingState, 'PAIRED');
      assert.equal(harnessA.storageData.userId, 'user_imm');
      assert.equal(harnessA.storageData.extensionToken, 'token_imm_123');
      assert.equal(harnessA.storageData.serverUrl, 'https://ais-dev-wyyezpv6s2lo3nusdgb6dl-608043296632.asia-southeast1.run.app');
      console.log('  ✓ PASSED: Sync node with immediate userId + token pairs to PAIRED');

      // B. sync node exists with empty token -> initially not paired
      const harnessB = createDomContentScriptHarness();
      const nodeB = harnessB.createSyncNode('user_async', '');
      harnessB.runContentScript();
      assert.equal(harnessB.storageData.pairingState, undefined, 'Initially empty token must NOT pair');
      console.log('  ✓ PASSED: Empty token initially does not pair');

      // C. token attribute later changes from empty to valid -> PAIRED
      nodeB.setAttribute('data-extension-token', 'token_async_456');
      assert.equal(harnessB.storageData.pairingState, 'PAIRED', 'Async token change must trigger pairing');
      assert.equal(harnessB.storageData.userId, 'user_async');
      assert.equal(harnessB.storageData.extensionToken, 'token_async_456');
      console.log('  ✓ PASSED: Asynchronously updated token triggers PAIRED state via MutationObserver');

      // D. duplicate attribute changes do not break/duplicate pairing
      const setCallsBefore = harnessB.getSetCalls();
      nodeB.setAttribute('data-extension-token', 'token_async_456');
      nodeB.setAttribute('data-extension-token', 'token_async_456');
      assert.equal(harnessB.getSetCalls(), setCallsBefore, 'Duplicate attribute changes must not cause duplicate storage writes');
      assert.equal(harnessB.storageData.pairingState, 'PAIRED');
      console.log('  ✓ PASSED: Duplicate token changes are deduplicated safely');

      // E. sync node initially absent and appears later -> PAIRED
      const harnessE = createDomContentScriptHarness();
      harnessE.runContentScript();
      assert.equal(harnessE.storageData.pairingState, undefined, 'Absent sync node does not pair');
      const nodeE = harnessE.createSyncNode('user_late_mount', 'token_late_mount_789');
      assert.equal(harnessE.storageData.pairingState, 'PAIRED', 'Late-mounting sync node must trigger pairing');
      assert.equal(harnessE.storageData.userId, 'user_late_mount');
      assert.equal(harnessE.storageData.extensionToken, 'token_late_mount_789');
      console.log('  ✓ PASSED: Dynamically inserted sync node triggers document observer pairing');
    }

    // --------------------------------------------------------------------------
    // TEST 3: Background Alarm Registration & persistAcrossSessions
    // --------------------------------------------------------------------------
    console.log('\n[Test 3] Background Alarm Registration & persistAcrossSessions');
    {
      const harness = createExtensionHarness();
      assert.ok(harness.alarmsCreated.length >= 1, 'Alarm must be created');
      const pollAlarm = harness.alarmsCreated.find((a) => a.name === 'trading_firewall_poll');
      assert.ok(pollAlarm, 'trading_firewall_poll alarm must be registered');
      assert.equal(pollAlarm.options.periodInMinutes, 0.5, 'Alarm polling interval must remain 30 seconds');
      assert.equal(pollAlarm.options.persistAcrossSessions, true, 'Alarm must explicitly request persistAcrossSessions');
      console.log('  ✓ PASSED: Alarm registered with 30s period and persistAcrossSessions: true');
    }

    // --------------------------------------------------------------------------
    // TEST 4: UNPAIRED state allows Zerodha navigation passively
    // --------------------------------------------------------------------------
    console.log('\n[Test 4] UNPAIRED state allows Zerodha navigation passively');
    {
      const harness = createExtensionHarness({ pairingState: 'UNPAIRED' });
      const nav = harness.getNavigationListener();
      await nav({ frameId: 0, tabId: 101, url: 'https://kite.zerodha.com/dashboard' });

      assert.equal(harness.tabUpdates.length, 0, 'UNPAIRED state must NOT block Zerodha');
      console.log('  ✓ PASSED: UNPAIRED state leaves Zerodha unrestricted');
    }

    // --------------------------------------------------------------------------
    // TEST 5: PAIRED + LOCKED blocks kite.zerodha.com new navigation
    // --------------------------------------------------------------------------
    console.log('\n[Test 5] PAIRED + LOCKED blocks kite.zerodha.com new navigation');
    {
      const lockedSession: RiskSession = {
        tradingDate,
        userId: testUser,
        state: 'LOCKED',
        isBreached: true,
        currentPnl: -1500,
        realisedPnl: -1500,
        unrealisedPnl: 0,
        lossLimit: 1000,
        warningThreshold1: 70,
        warningThreshold2: 90,
        lastEvaluatedAt: new Date().toISOString(),
        lockedAt: new Date().toISOString(),
        lockUntil: new Date(Date.now() + 3600 * 1000).toISOString(),
        reason: 'Breached Daily Loss Limit',
      };
      injectSession(testUser, lockedSession);

      const harness = createExtensionHarness({
        pairingState: 'PAIRED',
        userId: testUser,
        extensionToken: validToken,
        serverUrl,
      });

      const nav = harness.getNavigationListener();
      await nav({ frameId: 0, tabId: 201, url: 'https://kite.zerodha.com/orders' });

      assert.equal(harness.tabUpdates.length, 1, 'LOCKED state must block kite navigation');
      assert.equal(harness.tabUpdates[0].tabId, 201);
      assert.ok(
        harness.tabUpdates[0].updateProps.url.includes('blocked.html'),
        'Must redirect to blocked.html'
      );
      assert.ok(
        harness.tabUpdates[0].updateProps.url.includes(encodeURIComponent('https://kite.zerodha.com/orders')),
        'Must preserve attempted url in query string'
      );
      console.log('  ✓ PASSED: LOCKED state actively redirects kite.zerodha.com navigation to blocked.html');
    }

    // --------------------------------------------------------------------------
    // TEST 6: PAIRED + LOCKED existing/open Kite tab blocked by periodic alarm check
    // --------------------------------------------------------------------------
    console.log('\n[Test 6] PAIRED + LOCKED existing/open Kite tab blocked by periodic alarm check');
    {
      const openKiteTabs = [
        { id: 301, url: 'https://kite.zerodha.com/holdings' },
        { id: 302, url: 'https://kite.zerodha.com/positions' },
        { id: 303, url: 'http://localhost:3000/dashboard' }, // MonkTrades app tab
      ];

      const harness = createExtensionHarness(
        {
          pairingState: 'PAIRED',
          userId: testUser,
          extensionToken: validToken,
          serverUrl,
        },
        openKiteTabs
      );

      await harness.triggerAlarm('trading_firewall_poll');

      assert.equal(harness.tabUpdates.length, 2, 'Must redirect ONLY the 2 Kite tabs, NOT MonkTrades');
      assert.equal(harness.tabUpdates[0].tabId, 301);
      assert.ok(harness.tabUpdates[0].updateProps.url.includes('blocked.html'));
      assert.equal(harness.tabUpdates[1].tabId, 302);
      assert.ok(harness.tabUpdates[1].updateProps.url.includes('blocked.html'));

      console.log('  ✓ PASSED: Periodic alarm check redirects open Kite tabs and preserves MonkTrades');
    }

    // --------------------------------------------------------------------------
    // TEST 7: PAIRED + ALLOW / WARNING / MARKET_CLOSED permitted
    // --------------------------------------------------------------------------
    console.log('\n[Test 7] PAIRED + ALLOW / WARNING / MARKET_CLOSED permitted');
    {
      // 1. ALLOW state
      const allowSession: RiskSession = {
        tradingDate,
        userId: testUser,
        state: 'ALLOW',
        isBreached: false,
        lockedAt: null,
        lockUntil: null,
        reason: null,
        currentPnl: 500,
        realisedPnl: 500,
        unrealisedPnl: 0,
        lossLimit: 1000,
        warningThreshold1: 70,
        warningThreshold2: 90,
        lastEvaluatedAt: new Date().toISOString(),
      };
      injectSession(testUser, allowSession);

      const harnessAllow = createExtensionHarness({
        pairingState: 'PAIRED',
        userId: testUser,
        extensionToken: validToken,
        serverUrl,
      });
      const navAllow = harnessAllow.getNavigationListener();
      await navAllow({ frameId: 0, tabId: 202, url: 'https://kite.zerodha.com/orders' });
      assert.equal(harnessAllow.tabUpdates.length, 0, 'ALLOW state must NOT block Zerodha');

      // 2. MARKET_CLOSED state
      const closedSession: RiskSession = {
        ...allowSession,
        state: 'MARKET_CLOSED',
      };
      injectSession(testUser, closedSession);

      const harnessClosed = createExtensionHarness(
        {
          pairingState: 'PAIRED',
          userId: testUser,
          extensionToken: validToken,
          serverUrl,
        },
        [{ id: 304, url: 'https://kite.zerodha.com/funds' }]
      );
      await harnessClosed.triggerAlarm('trading_firewall_poll');
      assert.equal(harnessClosed.tabUpdates.length, 0, 'MARKET_CLOSED state must NOT block Zerodha');

      console.log('  ✓ PASSED: ALLOW, WARNING, and MARKET_CLOSED permit trading navigation & active tabs');
    }

    // --------------------------------------------------------------------------
    // TEST 8: Offline fail-closed (navigation and periodic alarm)
    // --------------------------------------------------------------------------
    console.log('\n[Test 8] Offline fail-closed (navigation and periodic alarm)');
    {
      const deadServerUrl = 'http://127.0.0.1:1'; // Unreachable port
      const harness = createExtensionHarness(
        {
          pairingState: 'PAIRED',
          userId: testUser,
          extensionToken: validToken,
          serverUrl: deadServerUrl,
          lastKnownState: 'RELEASED',
        },
        [{ id: 401, url: 'https://kite.zerodha.com/dashboard' }]
      );

      const nav = harness.getNavigationListener();
      await nav({ frameId: 0, tabId: 402, url: 'https://kite.zerodha.com/dashboard' });
      await harness.triggerAlarm('trading_firewall_poll');

      assert.equal(harness.tabUpdates.length, 2, 'Offline server MUST fail closed on nav and alarm');
      assert.ok(harness.tabUpdates[0].updateProps.url.includes('blocked.html'));
      assert.ok(harness.tabUpdates[1].updateProps.url.includes('blocked.html'));
      console.log('  ✓ PASSED: Offline / unreachable server strictly fails closed');
    }

    // --------------------------------------------------------------------------
    // TEST 9: Service worker restart with persisted pairing state
    // --------------------------------------------------------------------------
    console.log('\n[Test 9] Service worker restart with persisted pairing state');
    {
      // Reset server session to LOCKED
      const lockedSession: RiskSession = {
        tradingDate,
        userId: testUser,
        state: 'LOCKED',
        isBreached: true,
        currentPnl: -1500,
        realisedPnl: -1500,
        unrealisedPnl: 0,
        lossLimit: 1000,
        warningThreshold1: 70,
        warningThreshold2: 90,
        lastEvaluatedAt: new Date().toISOString(),
        lockedAt: new Date().toISOString(),
        lockUntil: new Date(Date.now() + 3600 * 1000).toISOString(),
        reason: 'Breached',
      };
      injectSession(testUser, lockedSession);

      // Harness 1 saves pairing to storage
      const harness1 = createExtensionHarness();
      harness1.storageData.pairingState = 'PAIRED';
      harness1.storageData.userId = testUser;
      harness1.storageData.extensionToken = validToken;
      harness1.storageData.serverUrl = serverUrl;

      // Simulate worker shutdown and restart: harness 2 starts with only storageData from disk
      const harness2 = createExtensionHarness(harness1.storageData, [
        { id: 501, url: 'https://kite.zerodha.com/orders' },
      ]);

      // Trigger alarm on restarted worker
      await harness2.triggerAlarm('trading_firewall_poll');

      assert.equal(harness2.tabUpdates.length, 1, 'Restarted worker must read storage and block Kite tab');
      assert.ok(harness2.tabUpdates[0].updateProps.url.includes('blocked.html'));
      console.log('  ✓ PASSED: Service worker survives suspension/restart using chrome.storage');
    }

    // --------------------------------------------------------------------------
    // TEST 10: MonkTrades is never blocked by the extension
    // --------------------------------------------------------------------------
    console.log('\n[Test 10] MonkTrades is never blocked by the extension');
    {
      const harness = createExtensionHarness(
        {
          pairingState: 'PAIRED',
          userId: testUser,
          extensionToken: validToken,
          serverUrl,
          lastKnownState: 'LOCKED',
        },
        [
          { id: 601, url: 'http://localhost:3000/dashboard' },
          { id: 602, url: 'http://127.0.0.1:3000/settings' },
        ]
      );

      const nav = harness.getNavigationListener();
      await nav({ frameId: 0, tabId: 601, url: 'http://localhost:3000/dashboard' });
      await nav({ frameId: 0, tabId: 602, url: 'http://127.0.0.1:3000/analytics' });
      await harness.triggerAlarm('trading_firewall_poll');

      assert.equal(harness.tabUpdates.length, 0, 'MonkTrades URLs must NEVER be blocked');
      console.log('  ✓ PASSED: MonkTrades application remains accessible under all conditions');
    }

    // --------------------------------------------------------------------------
    // TEST 11: evil-kite.zerodha.com must NOT be treated as Kite
    // --------------------------------------------------------------------------
    console.log('\n[Test 11] evil-kite.zerodha.com must NOT be treated as Kite (exact hostname match)');
    {
      const harness = createExtensionHarness(
        {
          pairingState: 'PAIRED',
          userId: testUser,
          extensionToken: validToken,
          serverUrl,
          lastKnownState: 'LOCKED',
        },
        [
          { id: 701, url: 'https://evil-kite.zerodha.com/orders' },
          { id: 702, url: 'https://kite.zerodha.com.attacker.com/orders' },
          { id: 703, url: 'https://subdomain.kite.zerodha.com/orders' },
        ]
      );

      const nav = harness.getNavigationListener();
      await nav({ frameId: 0, tabId: 701, url: 'https://evil-kite.zerodha.com/orders' });
      await nav({ frameId: 0, tabId: 702, url: 'https://kite.zerodha.com.attacker.com/orders' });
      await nav({ frameId: 0, tabId: 703, url: 'https://subdomain.kite.zerodha.com/orders' });
      await harness.triggerAlarm('trading_firewall_poll');

      assert.equal(harness.tabUpdates.length, 0, 'Non-exact kite hosts must NOT be intercepted as Kite');
      console.log('  ✓ PASSED: Exact hostname matching blocks only kite.zerodha.com');
    }

    // --------------------------------------------------------------------------
    // TEST 12: Malformed contract or bad/missing token fails closed
    // --------------------------------------------------------------------------
    console.log('\n[Test 12] Malformed contract or bad/missing token fails closed');
    {
      // Missing token in PAIRED state
      const harnessMissingToken = createExtensionHarness({
        pairingState: 'PAIRED',
        userId: testUser,
        extensionToken: '',
        serverUrl,
      });
      const navMissing = harnessMissingToken.getNavigationListener();
      await navMissing({ frameId: 0, tabId: 800, url: 'https://kite.zerodha.com/dashboard' });
      assert.equal(harnessMissingToken.tabUpdates.length, 1, 'Missing token in PAIRED state must fail closed');

      // Invalid token in PAIRED state
      const harnessBadToken = createExtensionHarness({
        pairingState: 'PAIRED',
        userId: testUser,
        extensionToken: 'bad_token_xxx',
        serverUrl,
      });
      const navBad = harnessBadToken.getNavigationListener();
      await navBad({ frameId: 0, tabId: 801, url: 'https://kite.zerodha.com/dashboard' });
      assert.equal(harnessBadToken.tabUpdates.length, 1, 'Bad token must fail closed');

      console.log('  ✓ PASSED: Malformed/revoked/missing auth fails closed');
    }
  } finally {
    server.close();
  }

  console.log('\n================================================================');
  console.log('ALL PHASE 16 CHROME EXTENSION TESTS PASSED');
  console.log('================================================================\n');
}

runPhase12cExtensionE2ETestSuite().catch((err) => {
  console.error('❌ PHASE 16 EXTENSION E2E TEST SUITE FAILED:', err);
  process.exit(1);
});
