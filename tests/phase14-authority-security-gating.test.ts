import { strict as assert } from 'assert';
import { apiRouter } from '../server/api';
import { ServerRiskStore } from '../server/risk/store';
import {
  LiveRiskRecorder,
  getLiveRiskStateRecordingEnabled,
  setLiveRiskStateRecordingEnabled,
  resetRecordingStates,
} from '../server/risk/liveRiskRecorder';
import { EnforcementService } from '../server/enforcement/service';
import { requireTradingAccess } from '../server/enforcement/guard';
import { authenticateRequest } from '../server/auth/session';
import { getTradingDateKolkata, RiskSession } from '../server/risk/engine';
import { DEFAULT_RISK_CONFIG } from '../src/types/risk';
import { enableMockStoreForTesting, setAdminFirestoreForTesting } from '../server/brokers/zerodha/sessionStore';

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
    redirect: (url: string) => {
      captured.data = { redirect: url };
      return res;
    },
    accepts: () => false,
  };
  return { res, getCaptured: () => captured };
}

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

async function runPhase14SecuritySuite() {
  console.log('================================================================');
  console.log('TRADING FIREWALL: PHASE 14 AUTHORITY & SECURITY GATING SUITE');
  console.log('Verified Token Authority, Fail-Closed Reads, & User Isolation');
  console.log('================================================================\n');

  enableMockStoreForTesting(true);
  ServerRiskStore.reset();
  resetRecordingStates();

  const userAlice = 'firebase_user_alice';
  const userBob = 'firebase_user_bob';

  // --------------------------------------------------------------------------
  // TEST 1: Forged x-user-id is rejected across user-scoped endpoints
  // --------------------------------------------------------------------------
  console.log('[Test 1] Forged x-user-id (Alice token with Bob x-user-id) rejected with HTTP 403');
  {
    const spoofReq: any = {
      headers: {
        authorization: `Bearer ${userAlice}`,
        'x-user-id': userBob, // Malicious mismatch
      },
    };

    // 1. Direct authenticateRequest
    const { res: resAuth, getCaptured: getCapturedAuth } = createMockRes();
    const uid = await authenticateRequest(spoofReq, resAuth);
    assert.equal(uid, null, 'authenticateRequest returns null on mismatch');
    assert.equal(getCapturedAuth().statusCode, 403, 'authenticateRequest sends HTTP 403');
    assert.equal(getCapturedAuth().data?.error, 'FORBIDDEN_USER_MISMATCH');

    // 2. /api/pnl
    const pnlHandler = getRouteHandler('/pnl', 'get');
    const { res: resPnl, getCaptured: getCapturedPnl } = createMockRes();
    await pnlHandler(spoofReq, resPnl, () => {});
    assert.equal(getCapturedPnl().statusCode, 403, '/pnl rejects user mismatch with 403');

    // 3. /api/risk
    const riskHandler = getRouteHandler('/risk', 'get');
    const { res: resRisk, getCaptured: getCapturedRisk } = createMockRes();
    await riskHandler(spoofReq, resRisk, () => {});
    assert.equal(getCapturedRisk().statusCode, 403, '/risk rejects user mismatch with 403');

    // 4. /api/risk/recording-status
    const recStatusHandler = getRouteHandler('/risk/recording-status', 'get');
    const { res: resRec, getCaptured: getCapturedRec } = createMockRes();
    await recStatusHandler(spoofReq, resRec, () => {});
    assert.equal(getCapturedRec().statusCode, 403, '/risk/recording-status rejects user mismatch with 403');

    // 5. /api/enforcement/status
    const enfHandler = getRouteHandler('/enforcement/status', 'get');
    const { res: resEnf, getCaptured: getCapturedEnf } = createMockRes();
    await enfHandler(spoofReq, resEnf, () => {});
    assert.equal(getCapturedEnf().statusCode, 403, '/enforcement/status rejects user mismatch with 403');

    console.log('  ✓ PASSED: Forged x-user-id strictly rejected across all user-scoped routes');
  }

  // --------------------------------------------------------------------------
  // TEST 2: Missing Bearer token (only x-user-id supplied) rejected with HTTP 401
  // --------------------------------------------------------------------------
  console.log('[Test 2] Missing Bearer token with only x-user-id header rejected with HTTP 401');
  {
    const noTokenReq: any = {
      headers: {
        'x-user-id': userAlice, // No Authorization Bearer header
      },
    };

    const { res: resAuth, getCaptured: getCapturedAuth } = createMockRes();
    const uid = await authenticateRequest(noTokenReq, resAuth);
    assert.equal(uid, null, 'authenticateRequest returns null when Bearer token is missing');
    assert.equal(getCapturedAuth().statusCode, 401, 'authenticateRequest sends HTTP 401');
    assert.equal(getCapturedAuth().data?.error, 'UNAUTHENTICATED');

    const pnlHandler = getRouteHandler('/pnl', 'get');
    const { res: resPnl, getCaptured: getCapturedPnl } = createMockRes();
    await pnlHandler(noTokenReq, resPnl, () => {});
    assert.equal(getCapturedPnl().statusCode, 401, '/pnl rejects unauthenticated request with 401');

    console.log('  ✓ PASSED: x-user-id without verified Bearer token strictly rejected with 401');
  }

  // --------------------------------------------------------------------------
  // TEST 3: Unauthorized recording control (enable / disable)
  // --------------------------------------------------------------------------
  console.log('[Test 3] Unauthorized recording control rejected fail-closed');
  {
    const controlHandler = getRouteHandler('/risk/recording/control', 'post');

    // Case A: Missing auth
    const reqNoAuth: any = {
      headers: {},
      body: { enabled: false },
    };
    const { res: resA, getCaptured: getCapturedA } = createMockRes();
    await controlHandler(reqNoAuth, resA, () => {});
    assert.equal(getCapturedA().statusCode, 401, 'Unauthenticated control returns 401');
    assert.equal(getCapturedA().data?.error, 'UNAUTHENTICATED');

    // Case B: Forged x-user-id attempting to disable someone else's recording
    const reqSpoof: any = {
      headers: {
        authorization: `Bearer ${userAlice}`,
        'x-user-id': userBob,
      },
      body: { enabled: false },
    };
    const { res: resB, getCaptured: getCapturedB } = createMockRes();
    await controlHandler(reqSpoof, resB, () => {});
    assert.equal(getCapturedB().statusCode, 403, 'Cross-user control returns 403');
    assert.equal(getCapturedB().data?.error, 'FORBIDDEN_USER_MISMATCH');

    console.log('  ✓ PASSED: Unauthorized recording control strictly protected');
  }

  // --------------------------------------------------------------------------
  // TEST 4: Protected route spoofing & requireTradingAccess guard
  // --------------------------------------------------------------------------
  console.log('[Test 4] Protected route spoofing blocked by requireTradingAccess');
  {
    // Case A: Unauthenticated request to /protected/trading
    const reqUnauth: any = { headers: {} };
    const { res: resA, getCaptured: getCapturedA } = createMockRes();
    let nextCalledA = false;
    await requireTradingAccess(reqUnauth, resA, () => { nextCalledA = true; });
    assert.equal(nextCalledA, false, 'Next NOT called for unauthenticated request');
    assert.equal(getCapturedA().statusCode, 401, 'requireTradingAccess returns 401');

    // Case B: Forged x-user-id to /protected/trading
    const reqSpoof: any = {
      headers: {
        authorization: `Bearer ${userAlice}`,
        'x-user-id': userBob,
      },
    };
    const { res: resB, getCaptured: getCapturedB } = createMockRes();
    let nextCalledB = false;
    await requireTradingAccess(reqSpoof, resB, () => { nextCalledB = true; });
    assert.equal(nextCalledB, false, 'Next NOT called for forged identity');
    assert.equal(getCapturedB().statusCode, 403, 'requireTradingAccess returns 403 on mismatch');

    // Case C: Authenticated but LOCKED user
    const tradingDate = getTradingDateKolkata();
    const lockedSession: RiskSession = {
      tradingDate,
      userId: userAlice,
      state: 'LOCKED',
      isBreached: true,
      lockedAt: new Date().toISOString(),
      lockUntil: new Date(Date.now() + 3600000).toISOString(),
      currentPnl: -1500,
      lossAmount: 1500,
      realisedPnl: -1500,
      unrealisedPnl: 0,
      lossLimit: 1000,
      warningThreshold1: 70,
      warningThreshold2: 85,
      lastEvaluatedAt: new Date().toISOString(),
      reason: 'Daily loss limit breached',
    };
    (ServerRiskStore as any).getOrCreateUserState(userAlice).sessions.set(tradingDate, lockedSession);

    const reqLocked: any = {
      headers: {
        authorization: `Bearer ${userAlice}`,
        'x-user-id': userAlice,
      },
    };
    const { res: resC, getCaptured: getCapturedC } = createMockRes();
    let nextCalledC = false;
    await requireTradingAccess(reqLocked, resC, () => { nextCalledC = true; });
    assert.equal(nextCalledC, false, 'Next NOT called for LOCKED user');
    assert.equal(getCapturedC().statusCode, 423, 'LOCKED user returns HTTP 423');
    assert.equal(getCapturedC().data?.error, 'TRADING_LOCKED');

    console.log('  ✓ PASSED: Protected trading route guarded against unauthenticated, spoofed, and LOCKED access');
  }

  // --------------------------------------------------------------------------
  // TEST 5: RiskSession Firestore read failure fails closed (throws & returns 500)
  // --------------------------------------------------------------------------
  console.log('[Test 5] RiskSession Firestore read failure fails closed (throws & denies trading)');
  {
    const failureUser = 'user_firestore_session_fail';
    const mockFaultyDb: any = {
      doc: (path: string) => ({
        get: async () => {
          if (path.includes('riskSessions')) {
            throw new Error('UNAVAILABLE: Firestore database connection dropped');
          }
          return { exists: false, data: () => null };
        },
      }),
    };

    setAdminFirestoreForTesting(mockFaultyDb);
    ServerRiskStore.reset();

    // 1. getSession MUST throw FIRESTORE_READ_FAILURE rather than returning default ALLOW
    let thrownError: any = null;
    try {
      await ServerRiskStore.getSession(failureUser);
    } catch (err) {
      thrownError = err;
    }
    assert(thrownError !== null, 'ServerRiskStore.getSession throws when Firestore fails');
    assert(
      thrownError.message.includes('FIRESTORE_READ_FAILURE'),
      'Error identifies FIRESTORE_READ_FAILURE'
    );

    // 2. EnforcementService & requireTradingAccess MUST fail closed (HTTP 500 AUTHORIZATION_UNAVAILABLE)
    const decision = await EnforcementService.checkTradingAccess(failureUser);
    assert.equal(decision.allowed, false, 'Trading access is denied when Firestore read fails');
    assert.equal(decision.statusCode, 500, 'Status code is 500');
    assert.equal(decision.error, 'AUTHORIZATION_UNAVAILABLE');

    const reqFaulty: any = {
      headers: {
        authorization: `Bearer ${failureUser}`,
        'x-user-id': failureUser,
      },
    };
    const { res: resF, getCaptured: getCapturedF } = createMockRes();
    let nextCalledF = false;
    await requireTradingAccess(reqFaulty, resF, () => { nextCalledF = true; });
    assert.equal(nextCalledF, false, 'requireTradingAccess does NOT call next on database failure');
    assert.equal(getCapturedF().statusCode, 500, 'requireTradingAccess sends HTTP 500');

    // Clean up mock DB
    setAdminFirestoreForTesting(null);
    console.log('  ✓ PASSED: RiskSession Firestore read failure fails closed with zero default ALLOW leak');
  }

  // --------------------------------------------------------------------------
  // TEST 6: RiskConfig Firestore read failure fails closed (throws)
  // --------------------------------------------------------------------------
  console.log('[Test 6] RiskConfig Firestore read failure fails closed (throws FIRESTORE_READ_FAILURE)');
  {
    const failureUser = 'user_firestore_config_fail';
    const mockFaultyDb: any = {
      doc: (path: string) => ({
        get: async () => {
          if (path.includes('riskConfig')) {
            throw new Error('PERMISSION_DENIED: Service account unauthorized for riskConfig');
          }
          return { exists: false, data: () => null };
        },
      }),
    };

    setAdminFirestoreForTesting(mockFaultyDb);
    ServerRiskStore.reset();

    let thrownError: any = null;
    try {
      await ServerRiskStore.getConfig(failureUser);
    } catch (err) {
      thrownError = err;
    }
    assert(thrownError !== null, 'ServerRiskStore.getConfig throws when Firestore fails');
    assert(
      thrownError.message.includes('FIRESTORE_READ_FAILURE'),
      'Error identifies FIRESTORE_READ_FAILURE'
    );

    setAdminFirestoreForTesting(null);
    console.log('  ✓ PASSED: RiskConfig Firestore read failure strictly throws and fails closed');
  }

  // --------------------------------------------------------------------------
  // TEST 7: Cross-user live recording isolation
  // --------------------------------------------------------------------------
  console.log('[Test 7] Cross-user live recording state is strictly isolated per user');
  {
    resetRecordingStates();

    const user1 = 'isolation_user_1';
    const user2 = 'isolation_user_2';
    const user3 = 'isolation_user_3';

    // Verify initial states are all false
    assert.equal(await getLiveRiskStateRecordingEnabled(user1), false, 'user1 recording starts false');
    assert.equal(await getLiveRiskStateRecordingEnabled(user2), false, 'user2 recording starts false');
    assert.equal(await getLiveRiskStateRecordingEnabled(user3), false, 'user3 recording starts false');

    // Enable for user1 ONLY
    await setLiveRiskStateRecordingEnabled(true, user1);

    // Verify strict isolation
    assert.equal(await getLiveRiskStateRecordingEnabled(user1), true, 'user1 recording is true');
    assert.equal(await getLiveRiskStateRecordingEnabled(user2), false, 'user2 recording remains strictly false');
    assert.equal(await getLiveRiskStateRecordingEnabled(user3), false, 'user3 recording remains strictly false');

    // Enable for user2
    await setLiveRiskStateRecordingEnabled(true, user2);
    assert.equal(await getLiveRiskStateRecordingEnabled(user1), true, 'user1 recording remains true');
    assert.equal(await getLiveRiskStateRecordingEnabled(user2), true, 'user2 recording is true');
    assert.equal(await getLiveRiskStateRecordingEnabled(user3), false, 'user3 recording remains false');

    // Disable for user1
    await setLiveRiskStateRecordingEnabled(false, user1);
    assert.equal(await getLiveRiskStateRecordingEnabled(user1), false, 'user1 recording is now false');
    assert.equal(await getLiveRiskStateRecordingEnabled(user2), true, 'user2 recording remains true');
    assert.equal(await getLiveRiskStateRecordingEnabled(user3), false, 'user3 recording remains false');

    // Global reset
    resetRecordingStates();
    assert.equal(await getLiveRiskStateRecordingEnabled(user1), false, 'user1 false after reset');
    assert.equal(await getLiveRiskStateRecordingEnabled(user2), false, 'user2 false after reset');
    assert.equal(await getLiveRiskStateRecordingEnabled(user3), false, 'user3 false after reset');

    console.log('  ✓ PASSED: Cross-user live recording isolation verified with zero state leakage');
  }

  console.log('\n================================================================');
  console.log('ALL 7 PHASE 14 SECURITY GATING REGRESSION TESTS PASSED (7/7)');
  console.log('================================================================\n');
}

runPhase14SecuritySuite().catch((err) => {
  console.error('Phase 14 Security Suite Error:', err);
  process.exit(1);
});
