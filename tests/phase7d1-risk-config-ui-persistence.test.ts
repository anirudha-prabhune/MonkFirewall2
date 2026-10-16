import { strict as assert } from 'assert';
import { apiRouter } from '../server/api';
import { ServerRiskStore, DEFAULT_ACCOUNT_ID, DEFAULT_ANGELONE_ACCOUNT_ID } from '../server/risk/store';
import { setAdminFirestoreForTesting, enableMockStoreForTesting } from '../server/brokers/zerodha/sessionStore';
import { validateRiskConfig } from '../src/utils/validation';

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

async function runPhase7D1Suite() {
  console.log('================================================================');
  console.log('MONKTRADES PHASE 7D.1: RISK CONFIG UI & PERSISTENCE REGRESSION');
  console.log('Account Identification, Isolation, Verification & Mode Integrity');
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

  const getRiskConfigHandler = findHandler('GET', '/risk/config');
  const putRiskConfigHandler = findHandler('PUT', '/risk/config');

  const testUserA = 'user_p7d1_trader_a';
  const testUserB = 'user_p7d1_trader_b';

  // TEST 1: Initial Load by Account ID identifies broker and default execution modes
  console.log('TEST 1: Initial Load identifies broker and execution modes accurately');
  {
    // Load Zerodha config
    const { res: resZ, getCaptured: getCapZ } = createMockRes();
    const reqZ: any = {
      headers: { authorization: `Bearer ${testUserA}`, 'x-user-id': testUserA, 'x-account-id': DEFAULT_ACCOUNT_ID },
      query: { accountId: DEFAULT_ACCOUNT_ID },
    };
    await getRiskConfigHandler(reqZ, resZ, () => {});
    const capZ = getCapZ();
    assert.equal(capZ.code, 200);
    assert.equal(capZ.data.accountId, DEFAULT_ACCOUNT_ID);
    assert.equal(capZ.data.broker, 'zerodha');
    assert.equal(capZ.data.executionMode, 'ENFORCE');
    assert.equal(capZ.data.dailyLossLimit, 10000);

    // Load Angel One config
    const { res: resA, getCaptured: getCapA } = createMockRes();
    const reqA: any = {
      headers: { authorization: `Bearer ${testUserA}`, 'x-user-id': testUserA, 'x-account-id': DEFAULT_ANGELONE_ACCOUNT_ID },
      query: { accountId: DEFAULT_ANGELONE_ACCOUNT_ID },
    };
    await getRiskConfigHandler(reqA, resA, () => {});
    const capA = getCapA();
    assert.equal(capA.code, 200);
    assert.equal(capA.data.accountId, DEFAULT_ANGELONE_ACCOUNT_ID);
    assert.equal(capA.data.broker, 'angelone');
    assert.equal(capA.data.executionMode, 'OBSERVE_ONLY');
    assert.equal(capA.data.dailyLossLimit, 10000);

    console.log('  ✓ PASSED: Zerodha loads as ENFORCE, Angel One loads as OBSERVE_ONLY');
  }

  // TEST 2: Edit, Save, and Verify Persistence for Zerodha
  console.log('\nTEST 2: Edit, Save, and Reload Persistence for Zerodha Account');
  {
    const updatePayload = {
      dailyLossLimit: 15000,
      warningThreshold1: 65,
      warningThreshold2: 85,
      lockDurationMinutes: 120,
      lockDurationType: 'FIXED',
      includeRealisedPnl: true,
      includeUnrealisedPnl: true,
      enabled: true,
      broker: 'zerodha',
    };

    const { res: putRes, getCaptured: getPutCap } = createMockRes();
    const putReq: any = {
      headers: { authorization: `Bearer ${testUserA}`, 'x-user-id': testUserA, 'x-account-id': DEFAULT_ACCOUNT_ID },
      query: { accountId: DEFAULT_ACCOUNT_ID },
      body: updatePayload,
    };
    await putRiskConfigHandler(putReq, putRes, () => {});
    const putCap = getPutCap();
    assert.equal(putCap.code, 200);
    assert.equal(putCap.data.success, true);
    assert.equal(putCap.data.config.dailyLossLimit, 15000);
    assert.equal(putCap.data.config.warningThreshold1, 65);
    assert.equal(putCap.data.config.accountId, DEFAULT_ACCOUNT_ID);

    // Reload from GET to verify persistence
    const { res: reloadRes, getCaptured: getReloadCap } = createMockRes();
    const reloadReq: any = {
      headers: { authorization: `Bearer ${testUserA}`, 'x-user-id': testUserA, 'x-account-id': DEFAULT_ACCOUNT_ID },
      query: { accountId: DEFAULT_ACCOUNT_ID },
    };
    await getRiskConfigHandler(reloadReq, reloadRes, () => {});
    const reloadCap = getReloadCap();
    assert.equal(reloadCap.code, 200);
    assert.equal(reloadCap.data.dailyLossLimit, 15000);
    assert.equal(reloadCap.data.warningThreshold1, 65);
    assert.equal(reloadCap.data.warningThreshold2, 85);
    assert.equal(reloadCap.data.lockDurationMinutes, 120);

    // Verify Angel One was untouched
    const { res: checkARes, getCaptured: getCheckACap } = createMockRes();
    const checkAReq: any = {
      headers: { authorization: `Bearer ${testUserA}`, 'x-user-id': testUserA, 'x-account-id': DEFAULT_ANGELONE_ACCOUNT_ID },
      query: { accountId: DEFAULT_ANGELONE_ACCOUNT_ID },
    };
    await getRiskConfigHandler(checkAReq, checkARes, () => {});
    const checkACap = getCheckACap();
    assert.equal(checkACap.code, 200);
    assert.equal(checkACap.data.dailyLossLimit, 10000);
    assert.equal(checkACap.data.executionMode, 'OBSERVE_ONLY');

    console.log('  ✓ PASSED: Zerodha config persisted; Angel One config remained strictly unmutated');
  }

  // TEST 3: Edit and Save Angel One enforces OBSERVE_ONLY and prevents cross-account leak
  console.log('\nTEST 3: Save Angel One forces OBSERVE_ONLY & prevents overwriting Zerodha');
  {
    const updateAngelPayload = {
      dailyLossLimit: 25000,
      warningThreshold1: 75,
      warningThreshold2: 95,
      lockDurationMinutes: 60,
      lockDurationType: 'FIXED',
      includeRealisedPnl: true,
      includeUnrealisedPnl: false,
      enabled: true,
      executionMode: 'ENFORCE', // Client attempts to switch to ENFORCE - must be blocked
      broker: 'angelone',
    };

    const { res: putRes, getCaptured: getPutCap } = createMockRes();
    const putReq: any = {
      headers: { authorization: `Bearer ${testUserA}`, 'x-user-id': testUserA, 'x-account-id': DEFAULT_ANGELONE_ACCOUNT_ID },
      query: { accountId: DEFAULT_ANGELONE_ACCOUNT_ID },
      body: updateAngelPayload,
    };
    await putRiskConfigHandler(putReq, putRes, () => {});
    const putCap = getPutCap();
    assert.equal(putCap.code, 200);
    assert.equal(putCap.data.success, true);
    assert.equal(putCap.data.config.dailyLossLimit, 25000);
    // Server-side boundary MUST maintain OBSERVE_ONLY
    assert.equal(putCap.data.config.executionMode, 'OBSERVE_ONLY');
    assert.equal(putCap.data.config.broker, 'angelone');
    assert.equal(putCap.data.config.accountId, DEFAULT_ANGELONE_ACCOUNT_ID);

    // Verify Zerodha still retains ₹15,000 and ENFORCE
    const { res: checkZRes, getCaptured: getCheckZCap } = createMockRes();
    const checkZReq: any = {
      headers: { authorization: `Bearer ${testUserA}`, 'x-user-id': testUserA, 'x-account-id': DEFAULT_ACCOUNT_ID },
      query: { accountId: DEFAULT_ACCOUNT_ID },
    };
    await getRiskConfigHandler(checkZReq, checkZRes, () => {});
    const checkZCap = getCheckZCap();
    assert.equal(checkZCap.code, 200);
    assert.equal(checkZCap.data.dailyLossLimit, 15000);
    assert.equal(checkZCap.data.executionMode, 'ENFORCE');
    assert.equal(checkZCap.data.broker, 'zerodha');

    console.log('  ✓ PASSED: Angel One forced to OBSERVE_ONLY; Zerodha unaffected');
  }

  // TEST 4: Account Switching and Rapid Reload (No Stale Form State)
  console.log('\nTEST 4: Account Switching and Reload guarantees correct account state');
  {
    // Simulate switching between account A and account B
    const seq = [
      { acc: DEFAULT_ACCOUNT_ID, expectedLimit: 15000, expectedMode: 'ENFORCE' },
      { acc: DEFAULT_ANGELONE_ACCOUNT_ID, expectedLimit: 25000, expectedMode: 'OBSERVE_ONLY' },
      { acc: DEFAULT_ACCOUNT_ID, expectedLimit: 15000, expectedMode: 'ENFORCE' },
    ];

    for (const step of seq) {
      const { res, getCaptured } = createMockRes();
      const req: any = {
        headers: { authorization: `Bearer ${testUserA}`, 'x-user-id': testUserA, 'x-account-id': step.acc },
        query: { accountId: step.acc },
      };
      await getRiskConfigHandler(req, res, () => {});
      const cap = getCaptured();
      assert.equal(cap.code, 200);
      assert.equal(cap.data.accountId, step.acc);
      assert.equal(cap.data.dailyLossLimit, step.expectedLimit);
      assert.equal(cap.data.executionMode, step.expectedMode);
    }

    console.log('  ✓ PASSED: Successive switches return independent authoritative configs without stale values');
  }

  // TEST 5: Failed saves reject invalid parameters and preserve existing config
  console.log('\nTEST 5: Failed Saves reject invalid input without corrupting stored config');
  {
    // Invalid limit below ₹500
    const invalidPayload1 = {
      dailyLossLimit: 300,
      warningThreshold1: 70,
      warningThreshold2: 90,
      lockDurationMinutes: 60,
    };
    const { res: res1, getCaptured: getCap1 } = createMockRes();
    const req1: any = {
      headers: { authorization: `Bearer ${testUserA}`, 'x-user-id': testUserA, 'x-account-id': DEFAULT_ACCOUNT_ID },
      query: { accountId: DEFAULT_ACCOUNT_ID },
      body: invalidPayload1,
    };
    await putRiskConfigHandler(req1, res1, () => {});
    const cap1 = getCap1();
    assert.equal(cap1.code, 400);
    assert.equal(cap1.data.success, false);
    assert(cap1.data.errors.some((e: string) => e.includes('at least ₹500')));

    // Invalid non-multiple of ₹500
    const invalidPayload2 = {
      dailyLossLimit: 5250,
      warningThreshold1: 70,
      warningThreshold2: 90,
      lockDurationMinutes: 60,
    };
    const { res: res2, getCaptured: getCap2 } = createMockRes();
    const req2: any = {
      headers: { authorization: `Bearer ${testUserA}`, 'x-user-id': testUserA, 'x-account-id': DEFAULT_ACCOUNT_ID },
      query: { accountId: DEFAULT_ACCOUNT_ID },
      body: invalidPayload2,
    };
    await putRiskConfigHandler(req2, res2, () => {});
    const cap2 = getCap2();
    assert.equal(cap2.code, 400);
    assert.equal(cap2.data.success, false);
    assert(cap2.data.errors.some((e: string) => e.includes('increments of ₹500')));

    // Re-verify Zerodha config was preserved
    const { res: verifyRes, getCaptured: getVerifyCap } = createMockRes();
    const verifyReq: any = {
      headers: { authorization: `Bearer ${testUserA}`, 'x-user-id': testUserA, 'x-account-id': DEFAULT_ACCOUNT_ID },
      query: { accountId: DEFAULT_ACCOUNT_ID },
    };
    await getRiskConfigHandler(verifyReq, verifyRes, () => {});
    const verifyCap = getVerifyCap();
    assert.equal(verifyCap.code, 200);
    assert.equal(verifyCap.data.dailyLossLimit, 15000);

    console.log('  ✓ PASSED: Invalid payloads rejected with 400; stored configuration preserved');
  }

  // TEST 6: User Isolation across accounts
  console.log('\nTEST 6: Multi-tenant user isolation');
  {
    // Trader B loads Zerodha config (must be default ₹10,000, not Trader A's ₹15,000)
    const { res: resB, getCaptured: getCapB } = createMockRes();
    const reqB: any = {
      headers: { authorization: `Bearer ${testUserB}`, 'x-user-id': testUserB, 'x-account-id': DEFAULT_ACCOUNT_ID },
      query: { accountId: DEFAULT_ACCOUNT_ID },
    };
    await getRiskConfigHandler(reqB, resB, () => {});
    const capB = getCapB();
    assert.equal(capB.code, 200);
    assert.equal(capB.data.dailyLossLimit, 10000);

    console.log('  ✓ PASSED: Trader B has completely isolated default config');
  }

  console.log('\n================================================================');
  console.log('PHASE 7D.1 TEST SUITE COMPLETE: ALL 6 TESTS PASSED');
  console.log('================================================================');
}

runPhase7D1Suite().catch((err) => {
  console.error('\n❌ PHASE 7D.1 TEST SUITE FAILED:', err);
  process.exit(1);
});
