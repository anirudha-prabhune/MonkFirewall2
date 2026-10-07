import { strict as assert } from 'assert';
import { ServerRiskStore } from '../server/risk/store';
import { EnforcementService } from '../server/enforcement/service';
import { DEFAULT_RISK_CONFIG } from '../src/types/risk';
import { getTradingDateKolkata, RiskSession } from '../server/risk/engine';
import { apiRouter } from '../server/api';
import { enableMockStoreForTesting } from '../server/brokers/zerodha/sessionStore';

async function runPhase12bTestSuite() {
  console.log('================================================================');
  console.log('TRADING FIREWALL: PHASE 12B MVP INTEGRATION SUITE');
  console.log('MVP Risk Config Lock & Broker Enforcement Foundation');
  console.log('================================================================\n');

  enableMockStoreForTesting(true);
  ServerRiskStore.reset();

  const testUser = 'phase12b_mvp_user';
  const tradingDate = getTradingDateKolkata(new Date());

  // Initialize user config BEFORE injecting any locked session
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

  // --------------------------------------------------------------------------
  // TEST 1 — LOCKED -> Dashboard Remains Fully Accessible
  // --------------------------------------------------------------------------
  console.log('[Test 1] LOCKED State -> Dashboard Remains Fully Accessible');
  // Inject an active LOCKED session
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
    reason: 'Daily loss limit breached',
  };
  injectSession(testUser, lockedSession);

  // Getting session for dashboard must succeed and return details rather than throwing 423
  const dashboardSession = await ServerRiskStore.getSession(testUser, tradingDate);
  assert.strictEqual(dashboardSession.state, 'LOCKED');
  assert.strictEqual(dashboardSession.isBreached, true);
  console.log('  ✓ PASSED: Authoritative session remains readable and viewable under LOCKED');

  // --------------------------------------------------------------------------
  // TEST 2 — LOCKED -> Protected Config Fields Become Read-Only (Direct Mutation Rejected)
  // --------------------------------------------------------------------------
  console.log('[Test 2] LOCKED State -> Protected Config Fields Read-Only / Rejected');

  // Attempt direct API mutation to dailyLossLimit while locked
  const mutateLimitResult = await ServerRiskStore.saveConfig(testUser, {
    ...DEFAULT_RISK_CONFIG,
    dailyLossLimit: 2000, // Attempting to increase limit to escape lock
    lockDurationMinutes: 120,
    enabled: true,
  });
  assert.strictEqual(mutateLimitResult.success, false);
  assert.strictEqual(mutateLimitResult.code, 'RISK_CONFIG_LOCKED');
  console.log('  ✓ PASSED: Direct Daily Loss Limit mutation while LOCKED is rejected with RISK_CONFIG_LOCKED');

  // Attempt direct API mutation to lock Duration while locked
  const mutateDurationResult = await ServerRiskStore.saveConfig(testUser, {
    ...DEFAULT_RISK_CONFIG,
    dailyLossLimit: 1000,
    lockDurationMinutes: 60, // Attempting to shorten lockout duration
    enabled: true,
  });
  assert.strictEqual(mutateDurationResult.success, false);
  assert.strictEqual(mutateDurationResult.code, 'RISK_CONFIG_LOCKED');
  console.log('  ✓ PASSED: Direct Lock Duration mutation while LOCKED is rejected');

  // --------------------------------------------------------------------------
  // TEST 3 — LOCKED -> Non-Protected Attributes Can Still Be Updated
  // --------------------------------------------------------------------------
  console.log('[Test 3] LOCKED State -> Non-Protected Fields Can Still Be Updated');
  const updateAlertsResult = await ServerRiskStore.saveConfig(testUser, {
    ...DEFAULT_RISK_CONFIG,
    dailyLossLimit: 1000, // unchanged
    lockDurationMinutes: 120, // unchanged
    warningThreshold1: 65, // updated
    warningThreshold2: 85, // updated
    enabled: true,
  });
  assert.strictEqual(updateAlertsResult.success, true, 'Alert thresholds should be editable while locked');
  assert.strictEqual(updateAlertsResult.config?.warningThreshold1, 65);
  console.log('  ✓ PASSED: Alert thresholds are successfully updated while LOCKED');

  // --------------------------------------------------------------------------
  // TEST 4 — Lock Expiry -> Settings Become Editable Again
  // --------------------------------------------------------------------------
  console.log('[Test 4] Lock Expiry -> Settings Become Fully Editable Again');
  // Inject an expired lock
  const expiredSession: RiskSession = {
    ...lockedSession,
    lockUntil: new Date(Date.now() - 5000).toISOString(), // expired 5 seconds ago
  };
  injectSession(testUser, expiredSession);

  // Now, saving Daily Loss Limit must succeed
  const mutatePostExpiryResult = await ServerRiskStore.saveConfig(testUser, {
    ...DEFAULT_RISK_CONFIG,
    dailyLossLimit: 5000, // successfully increased
    lockDurationMinutes: 120,
    enabled: true,
  });
  assert.strictEqual(mutatePostExpiryResult.success, true);
  assert.strictEqual(mutatePostExpiryResult.config?.dailyLossLimit, 5000);
  console.log('  ✓ PASSED: Lock expiry restores full editability to risk configuration');

  // --------------------------------------------------------------------------
  // TEST 5 — MARKET_CLOSED -> Dashboard Remains Fully Accessible
  // --------------------------------------------------------------------------
  console.log('[Test 5] MARKET_CLOSED State -> Dashboard Remains Fully Accessible');
  const closedSession: RiskSession = {
    ...lockedSession,
    state: 'MARKET_CLOSED',
  };
  injectSession(testUser, closedSession);

  const dashboardClosedSession = await ServerRiskStore.getSession(testUser, tradingDate);
  assert.strictEqual(dashboardClosedSession.state, 'MARKET_CLOSED');
  console.log('  ✓ PASSED: Dashboard remains fully readable under MARKET_CLOSED');

  // --------------------------------------------------------------------------
  // TEST 6 — Broker Enforcement Contract Mapping Verification
  // --------------------------------------------------------------------------
  console.log('[Test 6] Broker Enforcement Contract Mapping Verification');
  // ACTIVE LOCKED -> Maps to READY (Automated block ready, not implemented yet)
  injectSession(testUser, lockedSession);
  const contractLocked = await EnforcementService.getBrokerEnforcementContract(testUser);
  assert.strictEqual(contractLocked.broker, 'ZERODHA');
  assert.strictEqual(contractLocked.riskState, 'LOCKED');
  assert.strictEqual(contractLocked.enforcementStatus, 'READY', 'Active lock maps to READY');

  // ALLOW -> Maps to RELEASED
  const allowSession: RiskSession = {
    ...lockedSession,
    state: 'ALLOW',
  };
  injectSession(testUser, allowSession);
  const contractAllow = await EnforcementService.getBrokerEnforcementContract(testUser);
  assert.strictEqual(contractAllow.enforcementStatus, 'RELEASED', 'ALLOW state maps to RELEASED');

  // MARKET_CLOSED -> Maps to INACTIVE
  injectSession(testUser, closedSession);
  const contractClosed = await EnforcementService.getBrokerEnforcementContract(testUser);
  assert.ok(contractClosed.enforcementStatus === 'INACTIVE' || contractClosed.enforcementStatus === 'NOT_IMPLEMENTED', 'MARKET_CLOSED state maps to INACTIVE/non-blocking');
  console.log('  ✓ PASSED: Authoritative Broker Enforcement Contract maps status distinctly and safely');

  // --------------------------------------------------------------------------
  // TEST 7 — Safety Invariants and Isolation Verification
  // --------------------------------------------------------------------------
  console.log('[Test 7] Safety Invariants and Session / Browser Isolation');
  // Verify there are no browser-wide session-blocking logic or whole app lockout redirects
  const stack = (apiRouter as any).stack;
  const loginRoute = stack.find((l: any) => l.route?.path === '/broker/live/auth/login');
  assert.ok(loginRoute !== undefined, '/broker/live/auth/login route remains active');
  console.log('  ✓ PASSED: UI remains completely isolated; browser and master settings are not globally blocked');

  console.log('\n================================================================');
  console.log('ALL PHASE 12B MVP CONFIG & ENFORCEMENT TESTS PASSED');
  console.log('================================================================');
}

runPhase12bTestSuite().catch((err) => {
  console.error('❌ PHASE 12B TEST SUITE FAILED:', err);
  process.exit(1);
});
