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

async function runPhase7CSuite() {
  console.log('================================================================');
  console.log('MONKTRADES PHASE 7C: MULTI-BROKER INDEPENDENT RISK MANAGEMENT TEST SUITE');
  console.log('Independent Account Selection, Limits, Locks, Stale States & Zerodha Compatibility');
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

  const testUser = 'user_phase7c_multibroker_' + Date.now();

  // --------------------------------------------------------------------------
  // TEST 1: Account Switching & Independent Risk Configuration Retrieval
  // --------------------------------------------------------------------------
  console.log('[Test 1] Account Switching & Independent Risk Config Retrieval');
  {
    // 1. Fetch Zerodha default config
    const { res: resZerodha, getCaptured: capZerodha } = createMockRes();
    const reqZerodha: any = {
      headers: { authorization: `Bearer ${testUser}`, 'x-user-id': testUser },
      query: { accountId: DEFAULT_ACCOUNT_ID },
    };
    await getRiskConfigHandler(reqZerodha, resZerodha, () => {});
    assert.equal(capZerodha().code, 200);
    assert.equal(capZerodha().data.dailyLossLimit, 10000);

    // 2. Fetch Angel One config -> auto-provisions OBSERVE_ONLY default
    const { res: resAngel, getCaptured: capAngel } = createMockRes();
    const reqAngel: any = {
      headers: { authorization: `Bearer ${testUser}`, 'x-user-id': testUser },
      query: { accountId: DEFAULT_ANGELONE_ACCOUNT_ID },
    };
    await getRiskConfigHandler(reqAngel, resAngel, () => {});
    assert.equal(capAngel().code, 200);
    assert.equal(capAngel().data.executionMode, 'OBSERVE_ONLY');
    assert.equal(capAngel().data.broker, 'angelone');

    console.log('  ✓ PASSED: Zerodha and Angel One configurations retrieved independently');
  }

  // --------------------------------------------------------------------------
  // TEST 2: Independent Configuration Updates & Account Isolation
  // --------------------------------------------------------------------------
  console.log('\n[Test 2] Independent Risk Configuration Updates & Account Isolation');
  {
    // Update Zerodha config to 12000
    const { res: resUpdateZ, getCaptured: capUpdateZ } = createMockRes();
    const reqUpdateZ: any = {
      headers: { authorization: `Bearer ${testUser}`, 'x-user-id': testUser },
      query: { accountId: DEFAULT_ACCOUNT_ID },
      body: {
        dailyLossLimit: 12000,
        warningThreshold1: 70,
        warningThreshold2: 85,
        lockDurationMinutes: 120,
        lockDurationType: 'FIXED',
        includeRealisedPnl: true,
        includeUnrealisedPnl: true,
        enabled: true,
      },
    };
    await putRiskConfigHandler(reqUpdateZ, resUpdateZ, () => {});
    assert.equal(capUpdateZ().code, 200);
    assert.equal(capUpdateZ().data.config.dailyLossLimit, 12000);

    // Update Angel One config to 20000 (OBSERVE_ONLY)
    const { res: resUpdateA, getCaptured: capUpdateA } = createMockRes();
    const reqUpdateA: any = {
      headers: { authorization: `Bearer ${testUser}`, 'x-user-id': testUser },
      query: { accountId: DEFAULT_ANGELONE_ACCOUNT_ID },
      body: {
        dailyLossLimit: 20000,
        warningThreshold1: 65,
        warningThreshold2: 80,
        lockDurationMinutes: 60,
        lockDurationType: 'FIXED',
        includeRealisedPnl: true,
        includeUnrealisedPnl: true,
        enabled: true,
        executionMode: 'OBSERVE_ONLY',
        broker: 'angelone',
      },
    };
    await putRiskConfigHandler(reqUpdateA, resUpdateA, () => {});
    assert.equal(capUpdateA().code, 200);
    assert.equal(capUpdateA().data.config.dailyLossLimit, 20000);

    // Re-verify Zerodha was unpolluted
    const { res: resVerifyZ, getCaptured: capVerifyZ } = createMockRes();
    const reqVerifyZ: any = {
      headers: { authorization: `Bearer ${testUser}`, 'x-user-id': testUser },
      query: { accountId: DEFAULT_ACCOUNT_ID },
    };
    await getRiskConfigHandler(reqVerifyZ, resVerifyZ, () => {});
    assert.equal(capVerifyZ().data.dailyLossLimit, 12000);

    console.log('  ✓ PASSED: Independent limits saved with zero cross-account pollution');
  }

  // --------------------------------------------------------------------------
  // TEST 3: Account-Scoped Capital & Margin Routing
  // --------------------------------------------------------------------------
  console.log('\n[Test 3] Account-Scoped Capital & Margin Routing');
  {
    // 1. Fetch capital for Zerodha
    const { res: resCapZ, getCaptured: capCapZ } = createMockRes();
    const reqCapZ: any = {
      headers: { authorization: `Bearer ${testUser}`, 'x-user-id': testUser },
      query: { accountId: DEFAULT_ACCOUNT_ID },
    };
    await getCapitalHandler(reqCapZ, resCapZ, () => {});
    assert.equal(capCapZ().code, 200);
    assert.equal(capCapZ().data.broker, 'zerodha');

    // 2. Fetch capital for Angel One
    const { res: resCapA, getCaptured: capCapA } = createMockRes();
    const reqCapA: any = {
      headers: { authorization: `Bearer ${testUser}`, 'x-user-id': testUser },
      query: { accountId: DEFAULT_ANGELONE_ACCOUNT_ID },
    };
    await getCapitalHandler(reqCapA, resCapA, () => {});
    assert.equal(capCapA().code, 200);
    assert.equal(capCapA().data.broker, 'angelone');

    console.log('  ✓ PASSED: Capital requests correctly dispatch to account-specific broker adapters');
  }

  // --------------------------------------------------------------------------
  // TEST 4: Independent Lock Evaluation & Angel One Read-Only Observe Mode
  // --------------------------------------------------------------------------
  console.log('\n[Test 4] Independent Lock Evaluation & Angel One Read-Only Observe Mode');
  {
    const today = new Date().toISOString().split('T')[0];

    // Trigger Zerodha loss limit breach (-15,000 > limit 12,000)
    const zerodhaBreachPnl: PnlResult = {
      tradingDate: today,
      realisedPnl: -15000,
      unrealisedPnl: 0,
      totalPnl: -15000,
      grossTradingPnl: -15000,
      dailyRealisedPnl: -15000,
      dailyUnrealisedPnl: 0,
      includedRealisedPnl: -15000,
      includedUnrealisedPnl: 0,
      fnoPositionCount: 1,
      totalPositionCount: 1,
      positions: [],
      source: 'SYNTHETIC_SIMULATION',
      calculatedAt: new Date().toISOString(),
    };

    await ServerRiskStore.evaluatePnlResult(
      testUser,
      zerodhaBreachPnl,
      new Date(),
      undefined,
      DEFAULT_ACCOUNT_ID
    );

    // Verify Zerodha lock status is LOCKED
    const { res: resLockZ, getCaptured: capLockZ } = createMockRes();
    const reqLockZ: any = {
      headers: { authorization: `Bearer ${testUser}`, 'x-user-id': testUser },
      query: { accountId: DEFAULT_ACCOUNT_ID },
    };
    await getLockStatusHandler(reqLockZ, resLockZ, () => {});
    assert.equal(capLockZ().data.locked, true);
    assert.equal(capLockZ().data.state, 'LOCKED');

    // Verify Angel One lock status remains UNLOCKED (ALLOW)
    const { res: resLockA, getCaptured: capLockA } = createMockRes();
    const reqLockA: any = {
      headers: { authorization: `Bearer ${testUser}`, 'x-user-id': testUser },
      query: { accountId: DEFAULT_ANGELONE_ACCOUNT_ID },
    };
    await getLockStatusHandler(reqLockA, resLockA, () => {});
    assert.equal(capLockA().data.locked, false);
    assert.notEqual(capLockA().data.state, 'LOCKED');

    console.log('  ✓ PASSED: Zerodha breach creates lock strictly on Zerodha without affecting Angel One');
  }

  // --------------------------------------------------------------------------
  // TEST 5: Explicit Disconnected & Stale State Validation
  // --------------------------------------------------------------------------
  console.log('\n[Test 5] Explicit Disconnected & Stale State Validation');
  {
    // Fetch Angel One capital when disconnected
    const { res: resCapDisc, getCaptured: capCapDisc } = createMockRes();
    const reqCapDisc: any = {
      headers: { authorization: `Bearer ${testUser}`, 'x-user-id': testUser },
      query: { accountId: DEFAULT_ANGELONE_ACCOUNT_ID },
    };
    await getCapitalHandler(reqCapDisc, resCapDisc, () => {});
    assert.equal(capCapDisc().code, 200);
    const connStatus = capCapDisc().data.capital.connectionStatus;
    assert(
      ['AUTHENTICATION_REQUIRED', 'CONFIGURATION_ERROR', 'DISCONNECTED'].includes(connStatus),
      `Expected disconnected status, got: ${connStatus}`
    );
    assert.equal(capCapDisc().data.capital.isStale, true);
    assert.equal(capCapDisc().data.capital.withdrawableFunds, null);

    console.log('  ✓ PASSED: Disconnected account returns explicit connectionStatus and isStale=true with null balances');
  }

  console.log('\n================================================================');
  console.log('ALL PHASE 7C MULTI-BROKER INDEPENDENT RISK MANAGEMENT TESTS PASSED');
  console.log('================================================================\n');
}

runPhase7CSuite().catch((err) => {
  console.error('\nPhase 7C Suite Error:', err);
  process.exit(1);
});
