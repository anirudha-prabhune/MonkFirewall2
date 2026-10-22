import { strict as assert } from 'assert';
import { apiRouter } from '../server/api';
import { ServerRiskStore } from '../server/risk/store';
import { EnforcementService } from '../server/enforcement/service';
import { requireTradingAccess } from '../server/enforcement/guard';
import { getTradingDateKolkata, RiskSession } from '../server/risk/engine';
import { DEFAULT_RISK_CONFIG } from '../src/types/risk';
import { enableMockStoreForTesting } from '../server/brokers/zerodha/sessionStore';

function getRouteHandler(path: string, method: 'get' | 'post' | 'put' = 'get') {
  const layer = (apiRouter as any).stack.find((r: any) => {
    if (r.route && r.route.path === path && r.route.methods[method]) {
      return true;
    }
    return false;
  });
  if (!layer) throw new Error(`Handler for ${method.toUpperCase()} ${path} not found`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

function createMockRes() {
  let captured: { statusCode: number; data: any } = { statusCode: 200, data: null };
  const res: any = {
    statusCode: 200,
    status: (code: number) => {
      captured.statusCode = code;
      res.statusCode = code;
      return res;
    },
    json: (data: any) => {
      captured.data = data;
      return res;
    },
    setHeader: () => res,
    end: (str?: string) => {
      if (str) {
        try {
          captured.data = JSON.parse(str);
        } catch {
          captured.data = str;
        }
      }
      return res;
    },
  };
  return { res, getCaptured: () => captured };
}

async function runMultiAccountAndAuthSecurityTests() {
  console.log('================================================================');
  console.log('MONKFIREWALL2: MULTI-ACCOUNT STATUS ACCURACY & AUTH GUARD TESTS');
  console.log('================================================================\n');

  enableMockStoreForTesting(true);
  ServerRiskStore.reset();

  const testUser = 'test_user_consistency_' + Date.now();
  const zerodhaAcc = 'acc_mt_zerodha_default';
  const angelAcc = 'acc_mt_angelone_default';
  const tradingDate = getTradingDateKolkata(new Date());

  // 1. Setup multi-account configurations
  await ServerRiskStore.saveConfig(
    testUser,
    {
      ...DEFAULT_RISK_CONFIG,
      accountId: zerodhaAcc,
      broker: 'zerodha',
      dailyLossLimit: 5000,
      enabled: true,
    },
    zerodhaAcc
  );

  await ServerRiskStore.saveConfig(
    testUser,
    {
      ...DEFAULT_RISK_CONFIG,
      accountId: angelAcc,
      broker: 'angelone',
      dailyLossLimit: 2000,
      enabled: true,
    },
    angelAcc
  );

  // 2. Inject independent sessions: Zerodha is ALLOW, Angel One is LOCKED
  const userState = (ServerRiskStore as any).getOrCreateUserState(testUser);

  const zerodhaSession: RiskSession = {
    tradingDate,
    userId: testUser,
    accountId: zerodhaAcc,
    state: 'ALLOW',
    isBreached: false,
    lockedAt: null,
    lockUntil: null,
    currentPnl: 500,
    lossAmount: 0,
    realisedPnl: 500,
    unrealisedPnl: 0,
    lossLimit: 5000,
    warningThreshold1: 3500,
    warningThreshold2: 4250,
    lastEvaluatedAt: new Date().toISOString(),
    reason: 'Normal trading',
  };

  const lockUntilTime = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const angelSession: RiskSession = {
    tradingDate,
    userId: testUser,
    accountId: angelAcc,
    state: 'LOCKED',
    isBreached: true,
    lockedAt: new Date().toISOString(),
    lockUntil: lockUntilTime,
    currentPnl: -2500,
    lossAmount: 2500,
    realisedPnl: -2500,
    unrealisedPnl: 0,
    lossLimit: 2000,
    warningThreshold1: 1400,
    warningThreshold2: 1700,
    lastEvaluatedAt: new Date().toISOString(),
    reason: 'Angel One Daily Loss Limit breached',
  };

  userState.accountSessions.set(`${zerodhaAcc}__${tradingDate}`, zerodhaSession);
  userState.accountSessions.set(`${angelAcc}__${tradingDate}`, angelSession);

  // --------------------------------------------------------------------------
  // TEST 1: /api/enforcement/status multi-account accuracy via query param
  // --------------------------------------------------------------------------
  console.log('[Test 1] /api/enforcement/status distinguishes accounts via query param');
  const getEnforcementHandler = getRouteHandler('/enforcement/status', 'get');

  // Query Zerodha account
  {
    const reqZerodha: any = {
      headers: { authorization: `Bearer ${testUser}` },
      query: { accountId: zerodhaAcc },
    };
    const { res, getCaptured } = createMockRes();
    await getEnforcementHandler(reqZerodha, res);

    const data = getCaptured().data;
    assert.equal(getCaptured().statusCode, 200);
    assert.equal(data.riskState, 'ALLOW');
    assert.equal(data.isLocked, false);
    assert.equal(data.accountId, zerodhaAcc);
    console.log('  ✓ Zerodha status correctly returned ALLOW (isLocked: false)');
  }

  // Query Angel One account
  {
    const reqAngel: any = {
      headers: { authorization: `Bearer ${testUser}` },
      query: { accountId: angelAcc },
    };
    const { res, getCaptured } = createMockRes();
    await getEnforcementHandler(reqAngel, res);

    const data = getCaptured().data;
    assert.equal(getCaptured().statusCode, 200);
    assert.equal(data.riskState, 'LOCKED');
    assert.equal(data.isLocked, true);
    assert.equal(data.accountId, angelAcc);
    assert.equal(data.lockUntil, lockUntilTime);
    console.log('  ✓ Angel One status correctly returned LOCKED (isLocked: true)');
  }

  // --------------------------------------------------------------------------
  // TEST 2: /api/enforcement/status multi-account accuracy via x-account-id header
  // --------------------------------------------------------------------------
  console.log('[Test 2] /api/enforcement/status distinguishes accounts via x-account-id header');
  {
    const reqHeaderAngel: any = {
      headers: {
        authorization: `Bearer ${testUser}`,
        'x-account-id': angelAcc,
      },
      query: {},
    };
    const { res, getCaptured } = createMockRes();
    await getEnforcementHandler(reqHeaderAngel, res);

    const data = getCaptured().data;
    assert.equal(getCaptured().statusCode, 200);
    assert.equal(data.riskState, 'LOCKED');
    assert.equal(data.isLocked, true);
    assert.equal(data.accountId, angelAcc);
    console.log('  ✓ Header-supplied x-account-id correctly scoped to Angel One');
  }

  // --------------------------------------------------------------------------
  // TEST 3: Consistency between /api/enforcement/status and /api/risk/lock-status & /api/lock/status
  // --------------------------------------------------------------------------
  console.log('[Test 3] Lock status consistency across endpoints');
  const getLockStatusHandler = getRouteHandler('/lock/status', 'get');
  const getRiskLockStatusHandler = getRouteHandler('/risk/lock-status', 'get');

  // Verify /api/lock/status for Angel One
  {
    const reqAngel: any = {
      headers: { authorization: `Bearer ${testUser}` },
      query: { accountId: angelAcc },
    };
    const { res, getCaptured } = createMockRes();
    await getLockStatusHandler(reqAngel, res);

    const data = getCaptured().data;
    assert.equal(getCaptured().statusCode, 200);
    assert.equal(data.locked, true);
    assert.equal(data.isBreached, true);
    assert.equal(data.accountId, angelAcc);
    console.log('  ✓ /api/lock/status correctly reports locked for Angel One');
  }

  // Verify /api/risk/lock-status alias for Angel One
  {
    const reqAngel: any = {
      headers: { authorization: `Bearer ${testUser}` },
      query: { accountId: angelAcc },
    };
    const { res, getCaptured } = createMockRes();
    await getRiskLockStatusHandler(reqAngel, res);

    const data = getCaptured().data;
    assert.equal(getCaptured().statusCode, 200);
    assert.equal(data.locked, true);
    assert.equal(data.accountId, angelAcc);
    console.log('  ✓ /api/risk/lock-status alias returns consistent locked response');
  }

  // --------------------------------------------------------------------------
  // TEST 4: requireTradingAccess - Rejected Authentication Guard Fail-Closed
  // --------------------------------------------------------------------------
  console.log('[Test 4] requireTradingAccess rejected authentication behavior');

  // Case 4A: Missing authorization header -> HTTP 401 UNAUTHENTICATED, next() NOT called
  {
    const req: any = { headers: {} };
    const { res, getCaptured } = createMockRes();
    let nextCalled = false;
    await requireTradingAccess(req, res, () => {
      nextCalled = true;
    });

    assert.equal(nextCalled, false, 'next() must NOT be called on missing auth');
    assert.equal(getCaptured().statusCode, 401);
    assert.equal(getCaptured().data?.error, 'UNAUTHENTICATED');
    console.log('  ✓ Missing auth header rejected with HTTP 401 UNAUTHENTICATED');
  }

  // Case 4B: Malformed bearer token -> HTTP 401 UNAUTHENTICATED, next() NOT called
  {
    const req: any = { headers: { authorization: 'Basic dXNlcjpwYXNz' } };
    const { res, getCaptured } = createMockRes();
    let nextCalled = false;
    await requireTradingAccess(req, res, () => {
      nextCalled = true;
    });

    assert.equal(nextCalled, false, 'next() must NOT be called on invalid auth header');
    assert.equal(getCaptured().statusCode, 401);
    assert.equal(getCaptured().data?.error, 'UNAUTHENTICATED');
    console.log('  ✓ Non-bearer authorization header rejected with HTTP 401 UNAUTHENTICATED');
  }

  // Case 4C: Cross-user identity spoofing (Bearer Alice, x-user-id Bob) -> HTTP 403, strictly NOT overwritten
  {
    const reqSpoof: any = {
      headers: {
        authorization: `Bearer ${testUser}`,
        'x-user-id': 'malicious_attacker_uid',
      },
    };
    const { res, getCaptured } = createMockRes();
    let nextCalled = false;
    await requireTradingAccess(reqSpoof, res, () => {
      nextCalled = true;
    });

    assert.equal(nextCalled, false, 'next() must NOT be called on identity mismatch');
    assert.equal(getCaptured().statusCode, 403, 'Response status must strictly be 403');
    assert.equal(getCaptured().data?.error, 'FORBIDDEN_USER_MISMATCH');
    console.log('  ✓ Spoofed x-user-id strictly rejected with HTTP 403 FORBIDDEN_USER_MISMATCH (not overwritten)');
  }

  // --------------------------------------------------------------------------
  // TEST 5: requireTradingAccess - Account Scoped Lock Enforcement
  // --------------------------------------------------------------------------
  console.log('[Test 5] requireTradingAccess account-scoped lock gating');

  // Case 5A: Trading request to unlocked Zerodha account -> Allowed, next() called
  {
    const reqZerodha: any = {
      headers: {
        authorization: `Bearer ${testUser}`,
        'x-user-id': testUser,
        'x-account-id': zerodhaAcc,
      },
      query: {},
    };
    const { res } = createMockRes();
    let nextCalled = false;
    await requireTradingAccess(reqZerodha, res, () => {
      nextCalled = true;
    });

    assert.equal(nextCalled, true, 'next() must be called for unlocked Zerodha account');
    assert.equal(reqZerodha.enforcementState?.isLocked, false);
    console.log('  ✓ Unlocked Zerodha account permitted to trade (HTTP 200, next called)');
  }

  // Case 5B: Trading request to locked Angel One account -> Blocked with HTTP 423
  {
    const reqAngel: any = {
      headers: {
        authorization: `Bearer ${testUser}`,
        'x-user-id': testUser,
        'x-account-id': angelAcc,
      },
      query: {},
    };
    const { res, getCaptured } = createMockRes();
    let nextCalled = false;
    await requireTradingAccess(reqAngel, res, () => {
      nextCalled = true;
    });

    assert.equal(nextCalled, false, 'next() must NOT be called for locked Angel One account');
    assert.equal(getCaptured().statusCode, 423, 'Locked account must return HTTP 423');
    assert.equal(getCaptured().data?.error, 'TRADING_LOCKED');
    assert.equal(getCaptured().data?.lockUntil, lockUntilTime);
    console.log('  ✓ Locked Angel One account blocked with HTTP 423 TRADING_LOCKED');
  }

  console.log('\n================================================================');
  console.log('ALL MULTI-ACCOUNT AND AUTH GUARD TESTS PASSED SUCCESSFULLY');
  console.log('================================================================\n');
}

runMultiAccountAndAuthSecurityTests().catch((err) => {
  console.error('❌ Test suite failed:', err);
  process.exit(1);
});
