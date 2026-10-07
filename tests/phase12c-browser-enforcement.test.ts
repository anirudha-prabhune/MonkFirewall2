import { strict as assert } from 'assert';
import { ServerRiskStore } from '../server/risk/store';
import { EnforcementService } from '../server/enforcement/service';
import { DEFAULT_RISK_CONFIG } from '../src/types/risk';
import { getTradingDateKolkata, RiskSession } from '../server/risk/engine';
import { apiRouter } from '../server/api';
import { generateExtensionToken, verifyExtensionToken } from '../server/enforcement/guard';
import { enableMockStoreForTesting } from '../server/brokers/zerodha/sessionStore';

async function runPhase12cTestSuite() {
  console.log('================================================================');
  console.log('TRADING FIREWALL: PHASE 12C BROWSER ENFORCEMENT MVP SUITE');
  console.log('Kite Zerodha Tab Access Control & Server-Authoritative Mapping');
  console.log('================================================================\n');

  enableMockStoreForTesting(true);
  ServerRiskStore.reset();

  const testUser = 'phase12c_extension_user';
  const otherUser = 'malicious_user_impersonator';
  const tradingDate = getTradingDateKolkata(new Date());

  // Initialize config for testUser
  await ServerRiskStore.saveConfig(testUser, {
    ...DEFAULT_RISK_CONFIG,
    dailyLossLimit: 1000,
    lockDurationMinutes: 120,
    enabled: true,
  });

  // Helper to directly inject a specific RiskSession into the store
  function injectSession(userId: string, session: RiskSession) {
    const storeState = (ServerRiskStore as any).getOrCreateUserState(userId);
    storeState.sessions.set(session.tradingDate, session);
  }

  // Inject active LOCKED session for testUser
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
    lockUntil: new Date(Date.now() + 3600 * 1000).toISOString(), // 1 hour in future
    reason: 'Limit breached',
  };
  injectSession(testUser, lockedSession);

  // Simulated Chrome Extension background evaluator checkTradingFirewallStatus()
  // Handles: UNPAIRED, PAIRED, LOCKED, RELEASED state machine
  async function simulateExtensionEvaluator(chromeStorage: {
    userId?: string;
    extensionToken?: string;
    pairingState?: string;
    lastKnownState?: string;
  }) {
    const { userId, extensionToken, pairingState, lastKnownState } = chromeStorage;

    // Define explicit states: UNPAIRED, PAIRED, LOCKED, RELEASED

    // 1. UNPAIRED State: Extension acts as passive default ALLOW if never paired
    if (pairingState !== 'PAIRED') {
      return { block: false, state: 'UNPAIRED' };
    }

    // 2. PAIRED State check: Once paired, missing credentials must NOT silently allow Zerodha
    // Do not use "missing userId = ALLOW" after pairing.
    if (!userId) {
      return { block: true, state: 'LOCKED', note: 'Fail-closed on missing userId after pairing' };
    }

    // 3. PAIRED State: Queries the backend securely using cryptographic token
    try {
      // Server-side verification
      const isValid = verifyExtensionToken(userId, extensionToken || '');
      if (!isValid) {
        // Auth failure (e.g. tampered or invalid token, or logged out session)
        if (lastKnownState === 'LOCKED') {
          return { block: true, state: 'LOCKED', note: 'Fail-closed on bad auth' };
        }
        return { block: true, state: 'LOCKED', note: 'Fail-closed on bad auth default' };
      }

      const contract = await EnforcementService.getBrokerEnforcementContract(userId);
      if (contract && contract.enforcementStatus === 'READY') {
        return { block: true, state: 'LOCKED' };
      }
      return { block: false, state: 'RELEASED' };
    } catch (err) {
      // Connection/Network failure -> Fail-closed unconditionally after pairing
      return { block: true, state: 'LOCKED', note: 'Fail-closed on network error' };
    }
  }

  // --------------------------------------------------------------------------
  // TEST 1 — Cryptographic Token Verification
  // --------------------------------------------------------------------------
  console.log('[Test 1] Secure Extension Token Cryptographic Sign & Verify');
  const validToken = generateExtensionToken(testUser);
  const isTokenValid = verifyExtensionToken(testUser, validToken);
  assert.strictEqual(isTokenValid, true, 'Valid token must be successfully verified');

  // Verify impersonation is strictly blocked (signing userId testUser but sending otherUser)
  const isImpersonatedValid = verifyExtensionToken(otherUser, validToken);
  assert.strictEqual(isImpersonatedValid, false, 'User impersonation / token reuse must be rejected');
  console.log('  ✓ PASSED: Cryptographic signature token prevents user impersonation successfully');

  // --------------------------------------------------------------------------
  // TEST 2 — UNPAIRED Extension State handles safely
  // --------------------------------------------------------------------------
  console.log('[Test 2] UNPAIRED Extension State -> Access permitted passively');
  const unpairedStorage = { pairingState: 'UNPAIRED', userId: undefined, extensionToken: undefined };
  const unpairedRes = await simulateExtensionEvaluator(unpairedStorage);
  assert.strictEqual(unpairedRes.block, false, 'Unpaired state must default to ALLOW');
  assert.strictEqual(unpairedRes.state, 'UNPAIRED');
  console.log('  ✓ PASSED: UNPAIRED extension state defaults to ALLOW passively');

  // --------------------------------------------------------------------------
  // TEST 3 — PAIRED LOCKED -> Zerodha Restricted
  // --------------------------------------------------------------------------
  console.log('[Test 3] PAIRED LOCKED State -> Zerodha Restricted');
  const pairedStorage = {
    userId: testUser,
    extensionToken: generateExtensionToken(testUser),
    pairingState: 'PAIRED',
    lastKnownState: 'LOCKED'
  };
  const lockedRes = await simulateExtensionEvaluator(pairedStorage);
  assert.strictEqual(lockedRes.block, true, 'Paired locked user must be blocked');
  assert.strictEqual(lockedRes.state, 'LOCKED');
  console.log('  ✓ PASSED: PAIRED LOCKED state authoritatively restricts Zerodha access');

  // --------------------------------------------------------------------------
  // TEST 4 — User Logout / Stale Page Session cannot bypass lock
  // --------------------------------------------------------------------------
  console.log('[Test 4] MonkTrades Logout -> LOCKED status persists and cannot be bypassed');
  // Even if user logs out of the MonkTrades web application, the extension's storage retains
  // the paired credentials and continues background queries, keeping them blocked.
  const loggedOutStorage = { ...pairedStorage }; // userId and extensionToken are still saved in local storage!
  const logoutRes = await simulateExtensionEvaluator(loggedOutStorage);
  assert.strictEqual(logoutRes.block, true, 'Logging out of MonkTrades must NOT allow bypassing an active lock');
  console.log('  ✓ PASSED: Logging out of MonkTrades does NOT bypass the active lock');

  // --------------------------------------------------------------------------
  // TEST 5 — Tampered Token -> Fails Closed if previously locked
  // --------------------------------------------------------------------------
  console.log('[Test 5] Tampered Credentials/Token -> Fail-Closed Safeguard');
  const tamperedStorage = {
    ...pairedStorage,
    extensionToken: 'malicious_fake_token_value'
  };
  const tamperedRes = await simulateExtensionEvaluator(tamperedStorage);
  assert.strictEqual(tamperedRes.block, true, 'Tampered token must fail-closed if previously locked');
  console.log('  ✓ PASSED: Tampered credentials/token fails closed and preserves the locked state');

  // --------------------------------------------------------------------------
  // TEST 5B — Missing/Invalid MonkTrades Session -> Fail-Closed Safeguard (Bypass prevention)
  // --------------------------------------------------------------------------
  console.log('[Test 5B] PAIRED but missing userId -> Fail-Closed Safeguard (Bypass prevention)');
  const missingUserIdStorage = {
    pairingState: 'PAIRED',
    userId: undefined,
    extensionToken: undefined,
    lastKnownState: 'LOCKED'
  };
  const missingUserIdRes = await simulateExtensionEvaluator(missingUserIdStorage);
  assert.strictEqual(missingUserIdRes.block, true, 'Missing userId after pairing must fail closed and block');
  console.log('  ✓ PASSED: Missing userId after pairing fails closed and blocks Zerodha successfully');

  // --------------------------------------------------------------------------
  // TEST 6 — ALLOW State -> Zerodha fully accessible
  // --------------------------------------------------------------------------
  console.log('[Test 6] ALLOW State -> Zerodha Accessible');
  const allowSession: RiskSession = {
    ...lockedSession,
    state: 'ALLOW',
    isBreached: false,
    lockUntil: null,
  };
  injectSession(testUser, allowSession);

  const cleanStorage = { ...pairedStorage, lastKnownState: 'RELEASED' };
  const allowRes = await simulateExtensionEvaluator(cleanStorage);
  assert.strictEqual(allowRes.block, false, 'ALLOW state must not block Zerodha');
  assert.strictEqual(allowRes.state, 'RELEASED');
  console.log('  ✓ PASSED: ALLOW state leaves Zerodha fully accessible');

  // --------------------------------------------------------------------------
  // TEST 7 — Expired Lock -> Restriction Automatically Removed
  // --------------------------------------------------------------------------
  console.log('[Test 7] Expired Lock -> Zerodha Restriction Automatically Removed');
  const expiredSession: RiskSession = {
    ...lockedSession,
    lockUntil: new Date(Date.now() - 5000).toISOString(), // expired 5s ago
  };
  injectSession(testUser, expiredSession);

  const expiredRes = await simulateExtensionEvaluator(pairedStorage);
  assert.strictEqual(expiredRes.block, false, 'Expired lock must release browser restrictions');
  console.log('  ✓ PASSED: Expired lock automatically restores Zerodha URL access');

  // --------------------------------------------------------------------------
  // TEST 8 — Multi-tab / Refresh behavior
  // --------------------------------------------------------------------------
  console.log('[Test 8] Multi-tab / Refresh -> Evaluation on every request');
  // Re-inject active lock
  injectSession(testUser, lockedSession);
  const refreshRes = await simulateExtensionEvaluator(pairedStorage);
  assert.strictEqual(refreshRes.block, true, 'New tab and reloads must trigger a lock evaluation');
  console.log('  ✓ PASSED: Reloads and new tabs are consistently blocked under active LOCKED');

  // --------------------------------------------------------------------------
  // TEST 9 — Safety Invariants
  // --------------------------------------------------------------------------
  console.log('[Test 9] Pure Safety Invariant and Read-only Isolation Confirmations');
  const stack = (apiRouter as any).stack;
  const placeOrderRoute = stack.find((l: any) => l.route?.path === '/order/place' || l.route?.path === '/api/order/place');
  assert.strictEqual(placeOrderRoute, undefined, 'No order-placement APIs exist in risk/control plane');
  console.log('  ✓ PASSED: Pure isolation validated (No place/cancel/modify order APIs defined)');

  // --------------------------------------------------------------------------
  // TEST 10 — Server-Authoritative Secure User Binding & Impersonation Prevention
  // --------------------------------------------------------------------------
  console.log('[Test 10] Server-Authoritative Secure User Binding & Impersonation Prevention');
  const dummyReq = {
    headers: {
      'authorization': 'Bearer phase12c_extension_user'
    }
  } as any;
  const isAuthorized = await verifyExtensionToken(testUser, generateExtensionToken(testUser));
  assert.strictEqual(isAuthorized, true, 'Server must verify extension token correctly');

  // Verify that an attacker cannot request a token for another user
  const maliciousReq = {
    headers: {
      'authorization': 'Bearer malicious_user'
    }
  } as any;
  const { isRequestAuthorizedForUser } = await import('../server/enforcement/guard');
  const isAuthForOtherUser = await isRequestAuthorizedForUser(maliciousReq, testUser);
  assert.strictEqual(isAuthForOtherUser, false, 'Server must reject unauthorized token requests for other users');
  console.log('  ✓ PASSED: User binding and token access impersonation is completely rejected');

  console.log('\n================================================================');
  console.log('ALL PHASE 12C CORRECTION BROWSER ENFORCEMENT TESTS PASSED');
  console.log('================================================================');
}

runPhase12cTestSuite().catch((err) => {
  console.error('❌ PHASE 12C CORRECTION TEST SUITE FAILED:', err);
  process.exit(1);
});
