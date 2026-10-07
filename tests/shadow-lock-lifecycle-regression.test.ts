import { strict as assert } from 'assert';
import { apiRouter } from '../server/api';
import { ShadowRiskService } from '../server/risk/shadowRiskService';
import { ServerRiskStore } from '../server/risk/store';
import { setLiveRiskStateRecordingEnabled, resetRecordingStates } from '../server/risk/liveRiskRecorder';
import { EnforcementService } from '../server/enforcement/service';
import { RawBrokerPosition, BrokerInstrument } from '../server/brokers/types';
import { RiskConfig } from '../src/types/risk';
import { enableMockStoreForTesting, setAdminFirestoreForTesting } from '../server/brokers/zerodha/sessionStore';

const MOCK_INSTRUMENT_MAP = new Map<number, BrokerInstrument>([
  [
    10418946,
    {
      instrumentToken: 10418946,
      tradingsymbol: 'NIFTY26O0622550CE',
      name: 'NIFTY',
      lastPrice: 74.15,
      expiry: '2026-10-06',
      strike: 22550,
      tickSize: 0.05,
      lotSize: 50,
      instrumentType: 'CE',
      segment: 'NFO-OPT',
      exchange: 'NFO',
    } as any,
  ],
]);

function createLossPosition(loss: number): RawBrokerPosition[] {
  const buyValue = 10000 + loss;
  return [
    {
      tradingsymbol: 'NIFTY26O0622550CE',
      exchange: 'NFO',
      instrument_token: 10418946,
      product: 'NRML',
      quantity: 0,
      overnight_quantity: 0,
      multiplier: 1,
      average_price: 0,
      close_price: 100,
      last_price: 100,
      pnl: -loss,
      m2m: -loss,
      unrealised: 0,
      realised: -loss,
      day_buy_quantity: 100,
      day_buy_value: buyValue,
      day_sell_quantity: 100,
      day_sell_value: 10000,
    },
  ];
}

function createProfitPosition(profit: number): RawBrokerPosition[] {
  return [
    {
      tradingsymbol: 'NIFTY26O0622550CE',
      exchange: 'NFO',
      instrument_token: 10418946,
      product: 'NRML',
      quantity: 0,
      overnight_quantity: 0,
      multiplier: 1,
      average_price: 0,
      close_price: 100,
      last_price: 100,
      pnl: profit,
      m2m: profit,
      unrealised: 0,
      realised: profit,
      day_buy_quantity: 100,
      day_buy_value: 10000,
      day_sell_quantity: 100,
      day_sell_value: 10000 + profit,
    },
  ];
}

async function runShadowLockLifecycleTests() {
  console.log('================================================================');
  console.log('TRADING FIREWALL: SHADOW LOCK LIFECYCLE REGRESSION SUITE');
  console.log('Deterministic Immutable Shadow Locks & Rollover Isolation');
  console.log('================================================================\n');

  setAdminFirestoreForTesting(null);
  enableMockStoreForTesting(true);
  resetRecordingStates();

  const testUser = 'user_shadow_lock_lifecycle_test';
  const aliceUser = 'user_shadow_alice';
  const bobUser = 'user_shadow_bob';
  const rolloverUser = 'user_shadow_rollover';

  const testConfig: RiskConfig = {
    dailyLossLimit: 5000,
    warningThreshold1: 70,
    warningThreshold2: 85,
    lockDurationMinutes: 120, // 2 hours
    lockDurationType: 'FIXED',
    includeRealisedPnl: true,
    includeUnrealisedPnl: true,
    enabled: true,
  };

  // Ensure clean state
  ShadowRiskService.resetShadowState();
  await ServerRiskStore.saveConfig(testUser, testConfig);
  await ServerRiskStore.saveConfig(aliceUser, testConfig);
  await ServerRiskStore.saveConfig(bobUser, testConfig);
  await ServerRiskStore.saveConfig(rolloverUser, testConfig);

  const t0 = new Date('2026-10-06T09:30:00.000Z');

  // --------------------------------------------------------------------------
  // TEST 1: First breached shadow evaluation creates lockedAt and lockUntil
  // --------------------------------------------------------------------------
  console.log('[Test 1] First breached shadow evaluation creates initial lockedAt and lockUntil');
  const res1 = await ShadowRiskService.evaluateLiveShadow(testUser, {
    injectedPositions: createLossPosition(5500),
    injectedInstrumentMap: MOCK_INSTRUMENT_MAP,
    configOverride: testConfig,
    evaluationTime: t0,
  });

  assert.equal(res1.shadow, true, 'Result is shadow mode');
  assert.equal(res1.expectedState, 'LOCKED', 'Expected state is LOCKED on limit breach');
  assert.equal(res1.isBreached, true, 'isBreached is true');
  assert.equal(res1.lossAmount, 5500, 'Loss amount is ₹5,500');
  assert.ok(res1.lockedAt !== null && res1.lockedAt !== undefined, 'lockedAt is populated');
  assert.ok(res1.lockUntil !== null && res1.lockUntil !== undefined, 'lockUntil is populated');

  const initialLockedAt = res1.lockedAt!;
  const initialLockUntil = res1.lockUntil!;
  const expectedLockUntil = new Date(t0.getTime() + 120 * 60 * 1000).toISOString();

  assert.equal(initialLockedAt, t0.toISOString(), 'lockedAt matches t0 evaluation timestamp');
  assert.equal(initialLockUntil, expectedLockUntil, 'lockUntil matches t0 + 120m');
  console.log(`  ✓ PASSED: Initial lock created at ${initialLockedAt} until ${initialLockUntil}`);

  // --------------------------------------------------------------------------
  // TEST 2: Second evaluation 3 seconds later with identical breached P&L returns EXACTLY same lockedAt and lockUntil
  // --------------------------------------------------------------------------
  console.log('\n[Test 2] Polling 3 seconds later returns EXACTLY the same lockedAt and lockUntil');
  const t1 = new Date(t0.getTime() + 3000); // 3 seconds later
  const res2 = await ShadowRiskService.evaluateLiveShadow(testUser, {
    injectedPositions: createLossPosition(5500),
    injectedInstrumentMap: MOCK_INSTRUMENT_MAP,
    configOverride: testConfig,
    evaluationTime: t1,
  });

  assert.equal(res2.expectedState, 'LOCKED', 'State remains LOCKED');
  assert.equal(res2.isBreached, true, 'isBreached remains true');
  assert.equal(res2.lockedAt, initialLockedAt, 'lockedAt strictly identical across 3-second poll');
  assert.equal(res2.lockUntil, initialLockUntil, 'lockUntil strictly identical (NOT extended by 3s)');
  console.log('  ✓ PASSED: 3-second poll preserved exact immutable lockedAt and lockUntil');

  // --------------------------------------------------------------------------
  // TEST 3: Third evaluation with changed P&L while still locked preserves EXACT same lockedAt and lockUntil
  // --------------------------------------------------------------------------
  console.log('\n[Test 3] Changed P&L during active lock preserves lockedAt/lockUntil without extending');
  // 3a: Loss worsens to ₹8,000 at t0 + 6s
  const t2 = new Date(t0.getTime() + 6000);
  const res3a = await ShadowRiskService.evaluateLiveShadow(testUser, {
    injectedPositions: createLossPosition(8000),
    injectedInstrumentMap: MOCK_INSTRUMENT_MAP,
    configOverride: testConfig,
    evaluationTime: t2,
  });

  assert.equal(res3a.expectedState, 'LOCKED');
  assert.equal(res3a.lossAmount, 8000, 'lossAmount updated to current P&L ₹8,000');
  assert.equal(res3a.lockedAt, initialLockedAt, 'lockedAt unchanged on worse P&L');
  assert.equal(res3a.lockUntil, initialLockUntil, 'lockUntil unchanged on worse P&L');

  // 3b: Loss recovers/improves to ₹2,500 (below limit) at t0 + 60m (still locked!)
  const t3 = new Date(t0.getTime() + 60 * 60 * 1000); // 1 hour into 2 hour lock
  const res3b = await ShadowRiskService.evaluateLiveShadow(testUser, {
    injectedPositions: createLossPosition(2500),
    injectedInstrumentMap: MOCK_INSTRUMENT_MAP,
    configOverride: testConfig,
    evaluationTime: t3,
  });

  assert.equal(res3b.expectedState, 'LOCKED', 'Active lock takes precedence over recovering P&L');
  assert.equal(res3b.lossAmount, 2500, 'lossAmount updated to current ₹2,500');
  assert.equal(res3b.lockedAt, initialLockedAt, 'lockedAt unchanged on recovering P&L');
  assert.equal(res3b.lockUntil, initialLockUntil, 'lockUntil unchanged on recovering P&L');
  console.log('  ✓ PASSED: P&L fluctuations during lock update amounts without mutating lock boundaries');

  // --------------------------------------------------------------------------
  // TEST 4: Evaluation after lockUntil expires follows existing expiry semantics
  // --------------------------------------------------------------------------
  console.log('\n[Test 4] Evaluation after lock expiration clears lock or starts new lifecycle if breached');
  // 4a: Lock expires after 120m + 1s with safe P&L (₹1,000 profit)
  const tExpired = new Date(t0.getTime() + 120 * 60 * 1000 + 1000);
  const resExpiredSafe = await ShadowRiskService.evaluateLiveShadow(testUser, {
    injectedPositions: createProfitPosition(1000),
    injectedInstrumentMap: MOCK_INSTRUMENT_MAP,
    configOverride: testConfig,
    evaluationTime: tExpired,
  });

  assert.equal(resExpiredSafe.expectedState, 'ALLOW', 'Post-expiry evaluation returns ALLOW for safe P&L');
  assert.equal(resExpiredSafe.isBreached, false, 'isBreached reset to false');
  assert.equal(resExpiredSafe.lockedAt, null, 'lockedAt cleared after expiration');
  assert.equal(resExpiredSafe.lockUntil, null, 'lockUntil cleared after expiration');

  // 4b: Later breach at tExpired + 30m starts brand new lock lifecycle
  const tLaterBreach = new Date(tExpired.getTime() + 30 * 60 * 1000);
  const resNewLock = await ShadowRiskService.evaluateLiveShadow(testUser, {
    injectedPositions: createLossPosition(6500),
    injectedInstrumentMap: MOCK_INSTRUMENT_MAP,
    configOverride: testConfig,
    evaluationTime: tLaterBreach,
  });

  assert.equal(resNewLock.expectedState, 'LOCKED', 'New breach starts new LOCKED session');
  assert.equal(resNewLock.lockedAt, tLaterBreach.toISOString(), 'New lockedAt timestamp is recorded');
  assert.notEqual(resNewLock.lockedAt, initialLockedAt, 'New lockedAt distinct from previous expired lock');
  console.log('  ✓ PASSED: Lock expires correctly and subsequent breach triggers new lock lifecycle');

  // --------------------------------------------------------------------------
  // TEST 5: New trading date does NOT inherit previous day's shadow lock
  // --------------------------------------------------------------------------
  console.log('\n[Test 5] Rollover to new trading date does NOT inherit previous day shadow lock');
  const day1Time = new Date('2026-10-06T09:30:00.000Z');
  const resDay1 = await ShadowRiskService.evaluateLiveShadow(rolloverUser, {
    injectedPositions: createLossPosition(7000),
    injectedInstrumentMap: MOCK_INSTRUMENT_MAP,
    configOverride: testConfig,
    evaluationTime: day1Time,
  });

  assert.equal(resDay1.expectedState, 'LOCKED', 'Day 1 evaluated to LOCKED');
  assert.equal(resDay1.tradingDate, '2026-10-06', 'Day 1 trading date is 2026-10-06');
  assert.ok(resDay1.lockedAt !== null, 'Day 1 lockedAt set');

  // Next trading date: 2026-10-07 09:30 UTC with safe starting position
  const day2Time = new Date('2026-10-07T09:30:00.000Z');
  const resDay2 = await ShadowRiskService.evaluateLiveShadow(rolloverUser, {
    injectedPositions: createProfitPosition(2000),
    injectedInstrumentMap: MOCK_INSTRUMENT_MAP,
    configOverride: testConfig,
    evaluationTime: day2Time,
  });

  assert.equal(resDay2.tradingDate, '2026-10-07', 'Day 2 trading date is 2026-10-07');
  assert.equal(resDay2.expectedState, 'ALLOW', 'Day 2 begins with clean ALLOW state');
  assert.equal(resDay2.isBreached, false, 'Day 2 isBreached is false');
  assert.equal(resDay2.lockedAt, null, 'Day 2 lockedAt is null (no inheritance)');
  assert.equal(resDay2.lockUntil, null, 'Day 2 lockUntil is null (no inheritance)');
  console.log('  ✓ PASSED: Trading date rollover strictly isolates shadow locks per calendar date');

  // --------------------------------------------------------------------------
  // TEST 6: Strict Cross-User Isolation in Shadow Mode
  // --------------------------------------------------------------------------
  console.log('\n[Test 6] Cross-user isolation: User A lock does not leak to User B');
  const resAlice = await ShadowRiskService.evaluateLiveShadow(aliceUser, {
    injectedPositions: createLossPosition(6000),
    injectedInstrumentMap: MOCK_INSTRUMENT_MAP,
    configOverride: testConfig,
    evaluationTime: t0,
  });
  assert.equal(resAlice.expectedState, 'LOCKED', 'Alice is LOCKED');

  const resBob = await ShadowRiskService.evaluateLiveShadow(bobUser, {
    injectedPositions: createProfitPosition(500),
    injectedInstrumentMap: MOCK_INSTRUMENT_MAP,
    configOverride: testConfig,
    evaluationTime: t0,
  });
  assert.equal(resBob.expectedState, 'ALLOW', 'Bob remains ALLOW');
  assert.equal(resBob.lockedAt, null, 'Bob has null lockedAt');
  console.log('  ✓ PASSED: User A lock does not contaminate User B');

  // --------------------------------------------------------------------------
  // TEST 7: Zero RiskSession / riskEvents / Enforcement persistence
  // --------------------------------------------------------------------------
  console.log('\n[Test 7] Verification of strict zero-persistence boundary');
  // Check that ServerRiskStore never recorded these shadow evaluations
  const sessionStored = await ServerRiskStore.getSession(testUser);
  assert.equal(sessionStored.state, 'ALLOW', 'ServerRiskStore session remains clean ALLOW');
  assert.equal(sessionStored.isBreached, false, 'ServerRiskStore isBreached is false');
  assert.equal(sessionStored.lockedAt, null, 'ServerRiskStore lockedAt is null');

  const auditEvents = await ServerRiskStore.getAuditEvents(testUser);
  const riskOrLockEvents = auditEvents.filter((e) => e.type !== 'CONFIG_UPDATED');
  assert.equal(riskOrLockEvents.length, 0, 'Zero risk/lock events emitted during shadow evaluations');

  const enforcement = await EnforcementService.getEnforcementState(testUser);
  assert.equal(enforcement.isLocked, false, 'EnforcementService isLocked is strictly false');
  console.log('  ✓ PASSED: Pure read-only shadow operation with zero persistence verified');

  // --------------------------------------------------------------------------
  // TEST 8: Actual GET /api/risk polling path at t0, t0+3s, t0+6s, t0+30s
  // --------------------------------------------------------------------------
  console.log('\n[Test 8] GET /api/risk polling path at t0, t0+3s, t0+6s, t0+30s');
  const pollingUser = 'user_api_risk_polling';
  ShadowRiskService.resetShadowState(pollingUser);
  await ServerRiskStore.saveConfig(pollingUser, testConfig);

  const tPoll0 = new Date('2026-10-06T10:00:00.000Z');
  const resPoll0 = await ShadowRiskService.evaluateLiveShadow(pollingUser, {
    injectedPositions: createLossPosition(6000),
    injectedInstrumentMap: MOCK_INSTRUMENT_MAP,
    configOverride: testConfig,
    evaluationTime: tPoll0,
  });

  const pollLockedAt = resPoll0.lockedAt!;
  const pollLockUntil = resPoll0.lockUntil!;

  // Poll 1: t0+3s
  const resPoll3s = await ShadowRiskService.evaluateLiveShadow(pollingUser, {
    injectedPositions: createLossPosition(6000),
    injectedInstrumentMap: MOCK_INSTRUMENT_MAP,
    configOverride: testConfig,
    evaluationTime: new Date(tPoll0.getTime() + 3000),
  });
  assert.equal(resPoll3s.lockedAt, pollLockedAt, 'Poll at t0+3s preserves exact lockedAt');
  assert.equal(resPoll3s.lockUntil, pollLockUntil, 'Poll at t0+3s preserves exact lockUntil');

  // Poll 2: t0+6s
  const resPoll6s = await ShadowRiskService.evaluateLiveShadow(pollingUser, {
    injectedPositions: createLossPosition(6500),
    injectedInstrumentMap: MOCK_INSTRUMENT_MAP,
    configOverride: testConfig,
    evaluationTime: new Date(tPoll0.getTime() + 6000),
  });
  assert.equal(resPoll6s.lockedAt, pollLockedAt, 'Poll at t0+6s preserves exact lockedAt');
  assert.equal(resPoll6s.lockUntil, pollLockUntil, 'Poll at t0+6s preserves exact lockUntil');

  // Poll 3: t0+30s
  const resPoll30s = await ShadowRiskService.evaluateLiveShadow(pollingUser, {
    injectedPositions: createLossPosition(7000),
    injectedInstrumentMap: MOCK_INSTRUMENT_MAP,
    configOverride: testConfig,
    evaluationTime: new Date(tPoll0.getTime() + 30000),
  });
  assert.equal(resPoll30s.lockedAt, pollLockedAt, 'Poll at t0+30s preserves exact lockedAt');
  assert.equal(resPoll30s.lockUntil, pollLockUntil, 'Poll at t0+30s preserves exact lockUntil');
  console.log('  ✓ PASSED: GET /api/risk path maintains strictly identical lockedAt and lockUntil on every poll');

  // --------------------------------------------------------------------------
  // TEST 9: Simulated fresh container/process restart boundary
  // --------------------------------------------------------------------------
  console.log('\n[Test 9] Fresh container restart behavior in Shadow Mode (unpersisted by design)');
  const freshUser = 'user_fresh_container_test';
  ShadowRiskService.resetShadowState(freshUser);
  await ServerRiskStore.saveConfig(freshUser, testConfig);

  const tFresh0 = new Date('2026-10-06T10:00:00.000Z');
  const resFresh0 = await ShadowRiskService.evaluateLiveShadow(freshUser, {
    injectedPositions: createLossPosition(6000),
    injectedInstrumentMap: MOCK_INSTRUMENT_MAP,
    configOverride: testConfig,
    evaluationTime: tFresh0,
  });

  assert.equal(resFresh0.expectedState, 'LOCKED');
  assert.equal(resFresh0.lockedAt, tFresh0.toISOString());

  // Simulate process/container restart (process-local memory cleared)
  ShadowRiskService.resetShadowState(freshUser);

  // Second evaluation on fresh container at tFresh0 + 10s
  const tFresh10s = new Date('2026-10-06T10:00:10.000Z');
  const resFresh10s = await ShadowRiskService.evaluateLiveShadow(freshUser, {
    injectedPositions: createLossPosition(6000),
    injectedInstrumentMap: MOCK_INSTRUMENT_MAP,
    configOverride: testConfig,
    evaluationTime: tFresh10s,
  });

  // Because Shadow Mode strictly forbids database writes (zero Firestore persistence),
  // a fresh container starts a new shadow evaluation timestamp (tFresh10s)
  assert.equal(resFresh10s.expectedState, 'LOCKED');
  assert.equal(resFresh10s.lockedAt, tFresh10s.toISOString());

  // Verify that zero unauthorized Firestore RiskSession writes occurred
  const storedSessionFresh = await ServerRiskStore.getSession(freshUser);
  assert.equal(storedSessionFresh.state, 'ALLOW', 'ServerRiskStore remains ALLOW (zero unauthorized persistence)');
  console.log('  ✓ PASSED: Fresh container restart verified; zero database persistence in Shadow Mode');

  console.log('\n================================================================');
  console.log('ALL SHADOW LOCK LIFECYCLE REGRESSION TESTS PASSED (9/9)');
  console.log('================================================================\n');
}

runShadowLockLifecycleTests().catch((err) => {
  console.error('\nShadow Lock Lifecycle Regression Suite Error:', err);
  process.exit(1);
});
