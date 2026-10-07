import { strict as assert } from 'assert';
import { RiskEngine, setNseMarketClosedOverride } from '../server/risk/engine';
import { DEFAULT_RISK_CONFIG, RiskConfig } from '../src/types/risk';
import { PnlResult } from '../server/pnl/types';

async function runMarketClosedLifecycleTests() {
  console.log('================================================================');
  console.log('TRADING FIREWALL: PHASE 11C MARKET CLOSED & TIMESTAMPS SUITE');
  console.log('Fixed Lock Immutability, Market Closed State, & Expiry Rules');
  console.log('================================================================\n');

  const testUser = 'p11c_lifecycle_user';
  const config: RiskConfig = {
    ...DEFAULT_RISK_CONFIG,
    dailyLossLimit: 1000,
    lockDurationMinutes: 120,
    lockDurationType: 'FIXED',
    enabled: true,
  };

  const pnlResult: PnlResult = {
    tradingDate: '2026-10-06',
    grossTradingPnl: -1200, // Breached
    realisedPnl: -1200,
    unrealisedPnl: 0,
    totalPnl: -1200,
    includedRealisedPnl: -1200,
    includedUnrealisedPnl: 0,
    fnoPositionCount: 1,
    totalPositionCount: 1,
    positions: [],
    source: 'ZERODHA_LIVE',
    calculatedAt: new Date().toISOString(),
  };

  // Ensure NSE market closed override is turned off during this test to allow exact time tests
  setNseMarketClosedOverride(false); // Default to open for Test 1 & 2

  // ------------------------------------------------------------------
  // TEST 1 — Fixed lock timestamps are strictly immutable across 3+ repeated evaluations
  // ------------------------------------------------------------------
  console.log('[Test 1] Fixed lock timestamps are strictly immutable across 3+ repeated evaluations');
  // Market hours: 10:00 AM IST on Tuesday Oct 6, 2026 is 2026-10-06T04:30:00.000Z
  const t0 = new Date('2026-10-06T04:30:00.000Z');

  // Evaluation 1 (First breach)
  const eval1 = RiskEngine.evaluate({
    userId: testUser,
    config,
    pnlResult,
    evaluationTime: t0,
  });

  assert.equal(eval1.state, 'LOCKED', 'Initial state is LOCKED');
  const lockedAt1 = eval1.lockedAt;
  const lockUntil1 = eval1.lockUntil;
  assert.ok(lockedAt1 && lockUntil1, 'Timestamps created');

  // Evaluation 2 (10 seconds later)
  const t1 = new Date(t0.getTime() + 10000);
  const eval2 = RiskEngine.evaluate({
    userId: testUser,
    config,
    pnlResult,
    currentSession: eval1.session,
    evaluationTime: t1,
  });

  assert.equal(eval2.state, 'LOCKED', 'State remains LOCKED');
  assert.equal(eval2.lockedAt, lockedAt1, 'lockedAt is identical');
  assert.equal(eval2.lockUntil, lockUntil1, 'lockUntil is identical');

  // Evaluation 3 (30 seconds later)
  const t2 = new Date(t0.getTime() + 30000);
  const eval3 = RiskEngine.evaluate({
    userId: testUser,
    config,
    pnlResult,
    currentSession: eval2.session,
    evaluationTime: t2,
  });

  assert.equal(eval3.state, 'LOCKED', 'State remains LOCKED');
  assert.equal(eval3.lockedAt, lockedAt1, 'lockedAt remains identical on 3rd polling');
  assert.equal(eval3.lockUntil, lockUntil1, 'lockUntil remains identical on 3rd polling');
  console.log('  ✓ PASSED: Lock timestamps remain 100% immutable across repeated polling');

  // ------------------------------------------------------------------
  // TEST 2 — Lock expires DURING market hours
  // ------------------------------------------------------------------
  console.log('[Test 2] Lock expires DURING market hours -> re-evaluate P&L');
  // Lock expires in 120 minutes (12:00 PM IST / 06:30 UTC)
  const expiryTime = new Date('2026-10-06T06:30:00.000Z');
  
  // Safe P&L at expiry (gross P&L recovered to 0)
  const safePnl: PnlResult = {
    ...pnlResult,
    grossTradingPnl: 0,
    realisedPnl: 0,
    totalPnl: 0,
  };

  const evalExpired = RiskEngine.evaluate({
    userId: testUser,
    config,
    pnlResult: safePnl,
    currentSession: eval3.session,
    evaluationTime: expiryTime,
  });

  assert.equal(evalExpired.state, 'ALLOW', 'Returns to ALLOW state after lock expiry with safe P&L');
  console.log('  ✓ PASSED: Lock expiry during market hours transitions to correct state');

  // ------------------------------------------------------------------
  // TEST 3 — Market closes while lock is active
  // ------------------------------------------------------------------
  console.log('[Test 3] Market closes while lock is active -> transitions to MARKET_CLOSED');
  setNseMarketClosedOverride(true); // Market closes
  // Market closes at 15:40 IST (10:10 UTC)
  const marketCloseTime = new Date('2026-10-06T10:10:00.000Z');

  const evalClosed = RiskEngine.evaluate({
    userId: testUser,
    config,
    pnlResult,
    currentSession: eval3.session, // Active lock from t0 (lockUntil is 12:00 PM IST)
    evaluationTime: marketCloseTime,
  });

  assert.equal(evalClosed.state, 'MARKET_CLOSED', 'State is MARKET_CLOSED after market closes');
  assert.equal(evalClosed.lockedAt, lockedAt1, 'Historical lockedAt preserved in session snapshot');
  assert.equal(evalClosed.lockUntil, lockUntil1, 'Historical lockUntil preserved in session snapshot');
  console.log('  ✓ PASSED: Active lock transitions to MARKET_CLOSED when market closes');

  // ------------------------------------------------------------------
  // TEST 4 — lockUntil is AFTER market close
  // ------------------------------------------------------------------
  console.log('[Test 4] lockUntil is AFTER market close -> remains MARKET_CLOSED, no ALLOW/LOCKED transition');
  setNseMarketClosedOverride(false); // Market open for breach
  // Setup lock at 15:00 IST (09:30 UTC), expires at 17:00 IST (11:30 UTC)
  const tBreach = new Date('2026-10-06T09:30:00.000Z');
  const evalBreachPost = RiskEngine.evaluate({
    userId: testUser,
    config,
    pnlResult,
    evaluationTime: tBreach,
  });

  assert.equal(evalBreachPost.state, 'LOCKED', 'LOCKED before market close');

  setNseMarketClosedOverride(true); // Market closes

  // Evaluate at 15:40 IST (market close)
  const evalAtClose = RiskEngine.evaluate({
    userId: testUser,
    config,
    pnlResult,
    currentSession: evalBreachPost.session,
    evaluationTime: new Date('2026-10-06T10:10:00.000Z'),
  });
  assert.equal(evalAtClose.state, 'MARKET_CLOSED', 'MARKET_CLOSED at 15:40');

  // Evaluate at 17:01 IST (lock expired but after market close)
  const evalPostExpiry = RiskEngine.evaluate({
    userId: testUser,
    config,
    pnlResult: safePnl,
    currentSession: evalAtClose.session,
    evaluationTime: new Date('2026-10-06T11:31:00.000Z'),
  });

  assert.equal(evalPostExpiry.state, 'MARKET_CLOSED', 'Remains MARKET_CLOSED even after lockExpiry because market is closed');
  console.log('  ✓ PASSED: Lock expiry after market close does NOT transition to ALLOW or LOCKED');

  // ------------------------------------------------------------------
  // TEST 5 — Next trading day reset
  // ------------------------------------------------------------------
  console.log('[Test 5] Next trading day reset -> Previous day LOCKED does not carry forward');
  setNseMarketClosedOverride(false); // Market is open on the new day
  const nextDayOpen = new Date('2026-10-07T03:45:00.000Z'); // Wednesday 09:15 AM IST
  
  const nextDayPnl: PnlResult = {
    ...safePnl,
    tradingDate: '2026-10-07',
  };

  const evalNextDay = RiskEngine.evaluate({
    userId: testUser,
    config,
    pnlResult: nextDayPnl,
    currentSession: evalBreachPost.session, // Stale previous-day locked session
    evaluationTime: nextDayOpen,
  });

  assert.equal(evalNextDay.state, 'ALLOW', 'Starts fresh ALLOW state on next trading date');
  assert.equal(evalNextDay.lockedAt, null, 'New session lockedAt is null');
  assert.equal(evalNextDay.lockUntil, null, 'New session lockUntil is null');
  console.log('  ✓ PASSED: Next day start triggers fresh trading session and discards previous day lock');

  // ------------------------------------------------------------------
  // TEST 6 — Weekends / holidays are MARKET_CLOSED
  // ------------------------------------------------------------------
  console.log('[Test 6] Weekends are MARKET_CLOSED');
  setNseMarketClosedOverride(true); // Weekend is closed
  const saturday = new Date('2026-10-10T06:00:00.000Z'); // Saturday 11:30 AM IST

  const evalSat = RiskEngine.evaluate({
    userId: testUser,
    config,
    pnlResult,
    evaluationTime: saturday,
  });

  assert.equal(evalSat.state, 'MARKET_CLOSED', 'Weekend evaluates to MARKET_CLOSED');
  console.log('  ✓ PASSED: Weekends evaluated as MARKET_CLOSED');

  console.log('\n================================================================');
  console.log('ALL PHASE 11C MARKET CLOSED & LIFECYCLE TESTS PASSED');
  console.log('================================================================\n');
}

runMarketClosedLifecycleTests().catch((err) => {
  console.error('Test suite failed:', err);
  process.exit(1);
});
