import { strict as assert } from 'assert';
import { apiRouter } from '../server/api';
import { ServerRiskStore, DEFAULT_ACCOUNT_ID, DEFAULT_ANGELONE_ACCOUNT_ID } from '../server/risk/store';
import { setAdminFirestoreForTesting, enableMockStoreForTesting } from '../server/brokers/zerodha/sessionStore';
import { PnlResult } from '../server/pnl/types';

function createMockRes() {
  let capturedCode = 200;
  let capturedData: any = null;
  const res: any = {
    statusCode: 200,
    setHeader: () => {},
    status: (code: number) => {
      capturedCode = code;
      return res;
    },
    json: (data: any) => {
      capturedData = data;
      return res;
    },
    end: (str?: string) => {
      if (str) {
        try {
          capturedData = JSON.parse(str);
        } catch {
          capturedData = str;
        }
      }
    },
  };
  return {
    res,
    getCaptured: () => ({ code: capturedCode, data: capturedData }),
  };
}

async function runPhase7DSuite() {
  console.log('================================================================');
  console.log('MONKTRADES PHASE 7D: MULTI-BROKER OPERATIONAL READINESS SUITE');
  console.log('Independent Risk Monitoring, Switching, Stale Protection & Safety');
  console.log('================================================================\n');

  enableMockStoreForTesting(true);
  setAdminFirestoreForTesting(null);
  ServerRiskStore.reset();

  const stack = (apiRouter as any).stack;
  const findHandler = (method: string, path: string) => {
    const layer = stack.find(
      (l: any) => l.route?.path === path && l.route?.methods?.[method.toLowerCase()]
    );
    assert(layer !== undefined, `Found route handler for ${method} ${path}`);
    return layer.route.stack[layer.route.stack.length - 1].handle;
  };

  const getCapitalHandler = findHandler('GET', '/broker/live/capital');
  const getPnlHandler = findHandler('GET', '/pnl');
  const getRiskConfigHandler = findHandler('GET', '/risk/config');
  const putRiskConfigHandler = findHandler('PUT', '/risk/config');
  const getLockStatusHandler = findHandler('GET', '/lock/status');
  const getRiskHandler = findHandler('GET', '/risk');

  const testUser = 'user_phase7d_readiness_' + Date.now();
  const zerodhaAcc = DEFAULT_ACCOUNT_ID;
  const angelAcc = DEFAULT_ANGELONE_ACCOUNT_ID;
  const secondaryZerodhaAcc = 'acc_mt_zerodha_secondary';

  // --------------------------------------------------------------------------
  // TEST 1: Backward Compatibility & Default Account Fallback
  // --------------------------------------------------------------------------
  console.log('[Test 1] Backward Compatibility & Default Account Fallback');
  {
    const { res, getCaptured } = createMockRes();
    const req: any = {
      headers: { authorization: `Bearer ${testUser}`, 'x-user-id': testUser },
      query: {},
    };
    await getRiskConfigHandler(req, res, () => {});
    const cap = getCaptured();
    assert.equal(cap.code, 200);
    assert.equal(cap.data.accountId, DEFAULT_ACCOUNT_ID);
    assert.equal(cap.data.broker, 'zerodha');
    console.log('  ✓ PASSED: Unspecified accountId defaults to Zerodha default account');
  }

  // --------------------------------------------------------------------------
  // TEST 2: Multi-Account Isolation & Independent Risk Configuration
  // --------------------------------------------------------------------------
  console.log('\n[Test 2] Multi-Account Isolation & Independent Risk Configuration');
  {
    // Save 3 distinct account configs
    const baseConfig = {
      warningThreshold1: 70,
      warningThreshold2: 85,
      lockDurationMinutes: 60,
      lockDurationType: 'FIXED' as const,
      includeRealisedPnl: true,
      includeUnrealisedPnl: true,
      enabled: true,
    };
    await ServerRiskStore.saveConfig(testUser, { ...baseConfig, dailyLossLimit: 8000, broker: 'zerodha' }, zerodhaAcc);
    await ServerRiskStore.saveConfig(testUser, { ...baseConfig, dailyLossLimit: 15000, executionMode: 'OBSERVE_ONLY', broker: 'angelone' }, angelAcc);
    await ServerRiskStore.saveConfig(testUser, { ...baseConfig, dailyLossLimit: 25000, broker: 'zerodha' }, secondaryZerodhaAcc);

    // Verify Zerodha 1
    const { res: rZ1, getCaptured: cZ1 } = createMockRes();
    await getRiskConfigHandler({ headers: { authorization: `Bearer ${testUser}`, 'x-user-id': testUser }, query: { accountId: zerodhaAcc } }, rZ1, () => {});
    assert.equal(cZ1().data.dailyLossLimit, 8000);

    // Verify Angel One
    const { res: rA, getCaptured: cA } = createMockRes();
    await getRiskConfigHandler({ headers: { authorization: `Bearer ${testUser}`, 'x-user-id': testUser }, query: { accountId: angelAcc } }, rA, () => {});
    assert.equal(cA().data.dailyLossLimit, 15000);
    assert.equal(cA().data.executionMode, 'OBSERVE_ONLY');

    // Verify Zerodha 2
    const { res: rZ2, getCaptured: cZ2 } = createMockRes();
    await getRiskConfigHandler({ headers: { authorization: `Bearer ${testUser}`, 'x-user-id': testUser }, query: { accountId: secondaryZerodhaAcc } }, rZ2, () => {});
    assert.equal(cZ2().data.dailyLossLimit, 25000);

    console.log('  ✓ PASSED: 3 distinct account risk configurations stored and retrieved independently');
  }

  // --------------------------------------------------------------------------
  // TEST 3: Account Switching Updates P&L, Capital, and Risk State Consistently
  // --------------------------------------------------------------------------
  console.log('\n[Test 3] Account Switching Updates P&L, Capital, and Risk State Consistently');
  {
    // 1. Fetch Zerodha capital
    const { res: resCapZ, getCaptured: capCapZ } = createMockRes();
    await getCapitalHandler({ headers: { authorization: `Bearer ${testUser}`, 'x-user-id': testUser }, query: { accountId: zerodhaAcc } }, resCapZ, () => {});
    assert.equal(capCapZ().code, 200);
    assert.equal(capCapZ().data.broker, 'zerodha');

    // 2. Fetch Angel One capital
    const { res: resCapA, getCaptured: capCapA } = createMockRes();
    await getCapitalHandler({ headers: { authorization: `Bearer ${testUser}`, 'x-user-id': testUser }, query: { accountId: angelAcc } }, resCapA, () => {});
    assert.equal(capCapA().code, 200);
    assert.equal(capCapA().data.broker, 'angelone');

    // 3. Fetch Angel One P&L
    const { res: resPnlA, getCaptured: capPnlA } = createMockRes();
    await getPnlHandler({ headers: { authorization: `Bearer ${testUser}`, 'x-user-id': testUser }, query: { accountId: angelAcc } }, resPnlA, () => {});
    assert.equal(capPnlA().code, 200);
    assert.equal(capPnlA().data.executionMode, 'OBSERVE_ONLY');

    console.log('  ✓ PASSED: Switching accounts consistently shifts broker routing and risk limits');
  }

  // --------------------------------------------------------------------------
  // TEST 4: Independent Lock Evaluation & Cross-Account Non-Contamination
  // --------------------------------------------------------------------------
  console.log('\n[Test 4] Independent Lock Evaluation & Cross-Account Non-Contamination');
  {
    const today = new Date().toISOString().split('T')[0];

    // Cause breach on Zerodha 1 (-10,000 > limit 8,000)
    const breachPnl: PnlResult = {
      tradingDate: today,
      realisedPnl: -10000,
      unrealisedPnl: 0,
      totalPnl: -10000,
      grossTradingPnl: -10000,
      dailyRealisedPnl: -10000,
      dailyUnrealisedPnl: 0,
      includedRealisedPnl: -10000,
      includedUnrealisedPnl: 0,
      fnoPositionCount: 1,
      totalPositionCount: 1,
      positions: [],
      source: 'SYNTHETIC_SIMULATION',
      calculatedAt: new Date().toISOString(),
    };

    await ServerRiskStore.evaluatePnlResult(testUser, breachPnl, new Date(), undefined, zerodhaAcc);

    // Verify Zerodha 1 is LOCKED
    const { res: resLockZ1, getCaptured: capLockZ1 } = createMockRes();
    await getLockStatusHandler({ headers: { authorization: `Bearer ${testUser}`, 'x-user-id': testUser }, query: { accountId: zerodhaAcc } }, resLockZ1, () => {});
    assert.equal(capLockZ1().data.locked, true);
    assert.equal(capLockZ1().data.state, 'LOCKED');

    // Verify Zerodha 2 is ALLOW (UNLOCKED)
    const { res: resLockZ2, getCaptured: capLockZ2 } = createMockRes();
    await getLockStatusHandler({ headers: { authorization: `Bearer ${testUser}`, 'x-user-id': testUser }, query: { accountId: secondaryZerodhaAcc } }, resLockZ2, () => {});
    assert.equal(capLockZ2().data.locked, false);
    assert.equal(capLockZ2().data.state, 'ALLOW');

    // Verify Angel One is ALLOW (UNLOCKED)
    const { res: resLockA, getCaptured: capLockA } = createMockRes();
    await getLockStatusHandler({ headers: { authorization: `Bearer ${testUser}`, 'x-user-id': testUser }, query: { accountId: angelAcc } }, resLockA, () => {});
    assert.equal(capLockA().data.locked, false);

    console.log('  ✓ PASSED: Lock established strictly on breached account with zero cross-account leakage');
  }

  // --------------------------------------------------------------------------
  // TEST 5: Explicit Disconnected & Stale UI State Guard
  // --------------------------------------------------------------------------
  console.log('\n[Test 5] Explicit Disconnected & Stale UI State Guard');
  {
    const { res: resCap, getCaptured: capCap } = createMockRes();
    await getCapitalHandler({ headers: { authorization: `Bearer ${testUser}`, 'x-user-id': testUser }, query: { accountId: angelAcc } }, resCap, () => {});
    assert.equal(capCap().code, 200);
    const connStatus = capCap().data.capital.connectionStatus;
    assert(['AUTHENTICATION_REQUIRED', 'CONFIGURATION_ERROR', 'DISCONNECTED'].includes(connStatus));
    assert.equal(capCap().data.capital.isStale, true);
    assert.equal(capCap().data.capital.withdrawableFunds, null);

    console.log('  ✓ PASSED: Disconnected account yields explicit connectionStatus and isStale=true');
  }

  console.log('\n================================================================');
  console.log('ALL PHASE 7D MULTI-BROKER OPERATIONAL READINESS TESTS PASSED');
  console.log('================================================================\n');
}

runPhase7DSuite().catch((err) => {
  console.error('\nPhase 7D Suite Error:', err);
  process.exit(1);
});
