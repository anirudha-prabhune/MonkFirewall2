import { strict as assert } from 'assert';
import { apiRouter } from '../server/api';
import { ServerRiskStore } from '../server/risk/store';
import { ZerodhaCredentialManager } from '../server/brokers/zerodha/credentials';
import {
  ZerodhaSessionStore,
  enableMockStoreForTesting,
  setAdminFirestoreForTesting,
} from '../server/brokers/zerodha/sessionStore';
import { DEFAULT_RISK_CONFIG, RiskConfig } from '../src/types/risk';
import { getTradingDateKolkata, RiskSession } from '../server/risk/engine';
import { saveRiskConfig } from '../src/services/riskConfigService';

async function runAuthoritativeBypassRegressionTests() {
  console.log('================================================================');
  console.log('TRADING FIREWALL: AUTHORITATIVE STATE & BYPASS REGRESSION SUITE');
  console.log('Testing Server Authoritative Boundaries & Fail-Closed Safeguards');
  console.log('================================================================\n');

  enableMockStoreForTesting(true);
  ServerRiskStore.reset();

  const stack = (apiRouter as any).stack;

  const getHandler = (path: string, method: string) => {
    const layer = stack.find((l: any) => l.route?.path === path && l.route?.methods?.[method.toLowerCase()]);
    assert(layer !== undefined, `Found ${method.toUpperCase()} ${path} route handler`);
    return layer.route.stack[layer.route.stack.length - 1].handle;
  };

  function createMockRes() {
    let captured: { code: number; data?: any } = { code: 200 };
    const res: any = {
      status: (code: number) => {
        captured.code = code;
        return res;
      },
      json: (data: any) => {
        captured.data = data;
        return res;
      },
      setHeader: () => res,
      end: (payloadStr?: string) => {
        if (payloadStr) {
          try {
            captured.data = JSON.parse(payloadStr);
          } catch {
            captured.data = payloadStr;
          }
        }
        return res;
      },
    };
    return { res, getCaptured: () => captured };
  }

  const evaluateHandler = getHandler('/risk/evaluate', 'POST');
  const configPutHandler = getHandler('/risk/config', 'PUT');

  const testUserA = 'regression_user_alpha';
  const testUserB = 'regression_user_beta';

  // --------------------------------------------------------------------------
  // TEST 1: Unauthenticated /risk/evaluate rejection (HTTP 401)
  // --------------------------------------------------------------------------
  console.log('[Test 1] Unauthenticated /api/risk/evaluate request is strictly rejected');
  {
    const req: any = {
      headers: {},
      body: {},
    };
    const { res, getCaptured } = createMockRes();
    await evaluateHandler(req, res, () => {});
    const captured = getCaptured();
    assert.strictEqual(captured.code, 401, 'Unauthenticated evaluate returns 401');
    assert.strictEqual(captured.data?.error, 'UNAUTHENTICATED');
    console.log('  ✓ PASSED: Unauthenticated /risk/evaluate rejected with HTTP 401');
  }

  // --------------------------------------------------------------------------
  // TEST 2: Production synthetic P&L rejection (HTTP 403)
  // --------------------------------------------------------------------------
  console.log('[Test 2] Production synthetic P&L evaluation request is rejected');
  {
    const prevNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';

    const req: any = {
      headers: { authorization: `Bearer ${testUserA}` },
      body: { pnl: -5000 },
    };
    const { res, getCaptured } = createMockRes();
    await evaluateHandler(req, res, () => {});
    const captured = getCaptured();

    process.env.NODE_ENV = prevNodeEnv;

    assert.strictEqual(captured.code, 403, 'Synthetic P&L in production returns 403');
    assert.strictEqual(captured.data?.error, 'FORBIDDEN_IN_PRODUCTION');
    console.log('  ✓ PASSED: Production synthetic P&L input strictly rejected with HTTP 403');
  }

  // --------------------------------------------------------------------------
  // TEST 3: Demo Reset rejection outside sandbox (HTTP 403)
  // --------------------------------------------------------------------------
  console.log('[Test 3] Demo reset request is rejected in production mode');
  {
    const prevNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';

    const req: any = {
      headers: { authorization: `Bearer ${testUserA}` },
      body: { reset: true },
    };
    const { res, getCaptured } = createMockRes();
    await evaluateHandler(req, res, () => {});
    const captured = getCaptured();

    process.env.NODE_ENV = prevNodeEnv;

    assert.strictEqual(captured.code, 403, 'Reset outside sandbox in production returns 403');
    assert.strictEqual(captured.data?.error, 'FORBIDDEN_IN_PRODUCTION');
    console.log('  ✓ PASSED: Reset request outside sandbox strictly rejected with HTTP 403');
  }

  // --------------------------------------------------------------------------
  // TEST 4: Direct Firestore config mutation no longer used by production UI
  // --------------------------------------------------------------------------
  console.log('[Test 4] Production saveRiskConfig routes strictly through Server API');
  {
    let serverApiCalled = false;
    let serverBody: any = null;

    // Mock global fetch to observe API call
    const originalFetch = global.fetch;
    (global as any).fetch = async (url: string, init: any) => {
      if (url === '/api/risk/config' && init.method === 'PUT') {
        serverApiCalled = true;
        serverBody = JSON.parse(init.body);
        return {
          ok: true,
          json: async () => ({
            success: true,
            config: { ...DEFAULT_RISK_CONFIG, ...serverBody },
          }),
        };
      }
      return originalFetch(url, init);
    };

    try {
      const updated = await saveRiskConfig(testUserA, {
        dailyLossLimit: 5000,
        warningThreshold1: 65,
        warningThreshold2: 85,
      });

      assert.strictEqual(serverApiCalled, true, 'saveRiskConfig must call server API PUT /api/risk/config');
      assert.strictEqual(serverBody.dailyLossLimit, 5000, 'Payload sent to server API');
      assert.strictEqual(updated.dailyLossLimit, 5000, 'Returned updated config');
      console.log('  ✓ PASSED: Production saveRiskConfig exclusively uses authenticated server API');
    } finally {
      global.fetch = originalFetch;
    }
  }

  // --------------------------------------------------------------------------
  // TEST 5: Locked config mutation rejected by Server API (HTTP 403 / RISK_CONFIG_LOCKED)
  // --------------------------------------------------------------------------
  console.log('[Test 5] Server API rejects dailyLossLimit and lockout schedule mutations while LOCKED');
  {
    const today = getTradingDateKolkata(new Date());

    // Save initial config
    await ServerRiskStore.saveConfig(testUserA, {
      ...DEFAULT_RISK_CONFIG,
      dailyLossLimit: 1000,
      lockDurationMinutes: 120,
      lockDurationType: 'FIXED',
    });

    // Inject active locked session
    const lockedSession: RiskSession = {
      tradingDate: today,
      userId: testUserA,
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
      reason: 'Loss limit breached',
    };
    const storeState = (ServerRiskStore as any).getOrCreateUserState(testUserA);
    storeState.sessions.set(today, lockedSession);

    // Attempt to mutate dailyLossLimit while locked
    const req: any = {
      headers: { authorization: `Bearer ${testUserA}` },
      body: {
        ...DEFAULT_RISK_CONFIG,
        dailyLossLimit: 2000, // Attempt to increase limit
      },
    };
    const { res, getCaptured } = createMockRes();
    await configPutHandler(req, res, () => {});
    const captured = getCaptured();

    assert.strictEqual(captured.code, 403, 'Mutating dailyLossLimit while locked returns HTTP 403');
    assert.strictEqual(captured.data?.code, 'RISK_CONFIG_LOCKED');
    console.log('  ✓ PASSED: Locked config dailyLossLimit mutation rejected with RISK_CONFIG_LOCKED (403)');

    // Attempt to mutate lockDurationMinutes while locked
    const req2: any = {
      headers: { authorization: `Bearer ${testUserA}` },
      body: {
        ...DEFAULT_RISK_CONFIG,
        dailyLossLimit: 1000,
        lockDurationMinutes: 180, // Attempt to change lock time to 180m while locked
      },
    };
    const { res: res2, getCaptured: getCaptured2 } = createMockRes();
    await configPutHandler(req2, res2, () => {});
    const captured2 = getCaptured2();

    assert.strictEqual(captured2.code, 403, 'Mutating lockDurationMinutes while locked returns HTTP 403');
    assert.strictEqual(captured2.data?.code, 'RISK_CONFIG_LOCKED');
    console.log('  ✓ PASSED: Locked config lockDurationMinutes mutation rejected with RISK_CONFIG_LOCKED (403)');
  }

  // --------------------------------------------------------------------------
  // TEST 6: Firestore RiskSession write failure does NOT silently succeed (Fails Closed)
  // --------------------------------------------------------------------------
  console.log('[Test 6] Firestore RiskSession transaction failure fails closed');
  {
    // Inject mock Admin Firestore that throws on runTransaction
    const mockFailingAdminDb: any = {
      doc: () => ({
        get: async () => ({ exists: false }),
      }),
      collection: () => ({
        doc: () => ({}),
      }),
      runTransaction: async () => {
        throw new Error('Simulated Firestore write timeout / unavailability');
      },
    };

    setAdminFirestoreForTesting(mockFailingAdminDb);
    enableMockStoreForTesting(false); // Enable Admin SDK path

    let failedClosed = false;
    try {
      await ServerRiskStore.evaluatePnlResult(testUserA, {
        tradingDate: getTradingDateKolkata(new Date()),
        realisedPnl: -100,
        unrealisedPnl: 0,
        totalPnl: -100,
        includedRealisedPnl: -100,
        includedUnrealisedPnl: 0,
        grossTradingPnl: -100,
        fnoPositionCount: 1,
        totalPositionCount: 1,
        positions: [],
        source: 'SYNTHETIC_SIMULATION',
        calculatedAt: new Date().toISOString(),
      });
    } catch (err: any) {
      if (err?.message?.includes('FIRESTORE_PERSISTENCE_FAILURE')) {
        failedClosed = true;
      }
    } finally {
      setAdminFirestoreForTesting(null);
      enableMockStoreForTesting(true);
    }

    assert.strictEqual(failedClosed, true, 'Firestore persistence failure must throw FIRESTORE_PERSISTENCE_FAILURE and fail closed');
    console.log('  ✓ PASSED: Firestore RiskSession write failure throws FIRESTORE_PERSISTENCE_FAILURE (Fails Closed)');
  }

  // --------------------------------------------------------------------------
  // TEST 7: User session never falls back to default_trader
  // --------------------------------------------------------------------------
  console.log('[Test 7] User session resolution never falls back to default_trader session');
  {
    // Save session strictly for default_trader
    await ZerodhaSessionStore.saveSession('default_trader', 'token_for_default_trader', {
      brokerUserId: 'DEF001',
    });

    // Invalidate User B
    await ZerodhaCredentialManager.disconnect(testUserB);

    // Query authenticated session for User B
    const sessionUserB = await ZerodhaCredentialManager.getAuthenticatedSession(testUserB);

    assert.strictEqual(sessionUserB, null, 'User B must not receive default_trader session');

    const presence = ZerodhaCredentialManager.getPresenceDiagnostic(testUserB);
    assert.strictEqual(presence.authenticated, false, 'User B presence must be unauthenticated');
    console.log('  ✓ PASSED: Disconnected user never inherits default_trader session or credentials');
  }

  console.log('\n================================================================');
  console.log('ALL AUTHORITATIVE STATE BYPASS REGRESSION TESTS PASSED (7/7)');
  console.log('================================================================');
}

runAuthoritativeBypassRegressionTests().catch((err) => {
  console.error('❌ AUTHORITATIVE BYPASS REGRESSION TESTS FAILED:', err);
  process.exit(1);
});
