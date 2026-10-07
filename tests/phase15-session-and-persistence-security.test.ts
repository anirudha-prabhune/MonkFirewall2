import { strict as assert } from 'assert';
import { apiRouter } from '../server/api';
import { ValidationSessionManager } from '../server/pnl/validationSession';
import {
  getLiveRiskStateRecordingEnabled,
  setLiveRiskStateRecordingEnabled,
  resetRecordingStates,
  LiveRiskRecorder,
} from '../server/risk/liveRiskRecorder';
import { verifyTokenAndGetUid } from '../server/auth/session';
import {
  getAdminFirestore,
  setAdminFirestoreForTesting,
  enableMockStoreForTesting,
} from '../server/brokers/zerodha/sessionStore';
import { ServerRiskStore } from '../server/risk/store';
import { ZerodhaCredentialManager } from '../server/brokers/zerodha/credentials';
import { generateExtensionToken, verifyExtensionToken } from '../server/enforcement/guard';

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

async function runPhase15SecuritySuite() {
  console.log('================================================================');
  console.log('TRADING FIREWALL: PHASE 15 SESSION & PERSISTENCE SECURITY SUITE');
  console.log('Validation Session Auth, User Isolation, Restarts & Sandbox Gate');
  console.log('================================================================\n');

  const stack = (apiRouter as any).stack;
  const findHandler = (method: string, path: string) => {
    const layer = stack.find(
      (l: any) => l.route?.path === path && l.route?.methods?.[method.toLowerCase()]
    );
    assert(layer !== undefined, `Found route handler for ${method} ${path}`);
    return layer.route.stack[layer.route.stack.length - 1].handle;
  };

  const startHandler = findHandler('POST', '/validation/session/start');
  const activeHandler = findHandler('GET', '/validation/session/active');
  const captureHandler = findHandler('POST', '/validation/session/capture');
  const endHandler = findHandler('POST', '/validation/session/end');
  const reportHandler = findHandler('GET', '/validation/session/report');
  const controlHandler = findHandler('POST', '/risk/recording/control');

  // --------------------------------------------------------------------------
  // REQUIREMENT 1: Protect ALL validation-session endpoints with verified Firebase auth
  // --------------------------------------------------------------------------
  console.log('[Req 1] Protecting ALL validation-session endpoints with verified Firebase authentication');
  {
    const validationRoutes = [
      { name: '/validation/session/start', handler: startHandler, method: 'POST', body: { notes: 'test' } },
      { name: '/validation/session/active', handler: activeHandler, method: 'GET', body: undefined },
      { name: '/validation/session/capture', handler: captureHandler, method: 'POST', body: undefined },
      { name: '/validation/session/end', handler: endHandler, method: 'POST', body: undefined },
      { name: '/validation/session/report', handler: reportHandler, method: 'GET', body: undefined },
    ];

    for (const route of validationRoutes) {
      // 1. Missing Bearer token completely
      const { res: resMissing, getCaptured: capMissing } = createMockRes();
      const reqMissing: any = { headers: {}, body: route.body, query: {} };
      await route.handler(reqMissing, resMissing, () => {});
      assert.equal(capMissing().code, 401, `${route.name}: Missing token returns HTTP 401`);
      assert.equal(capMissing().data?.error, 'UNAUTHENTICATED');

      // 2. Only x-user-id header without Bearer token (never trust x-user-id as identity)
      const { res: resSpoof, getCaptured: capSpoof } = createMockRes();
      const reqSpoof: any = { headers: { 'x-user-id': 'attacker_uid' }, body: route.body, query: {} };
      await route.handler(reqSpoof, resSpoof, () => {});
      assert.equal(capSpoof().code, 401, `${route.name}: x-user-id without token returns HTTP 401`);
      assert.equal(capSpoof().data?.error, 'UNAUTHENTICATED');

      // 3. Forged identity: Bearer token for user_alpha, but x-user-id claims user_beta
      const { res: resMismatch, getCaptured: capMismatch } = createMockRes();
      const reqMismatch: any = {
        headers: { authorization: 'Bearer user_alpha', 'x-user-id': 'user_beta' },
        body: route.body,
        query: {},
      };
      await route.handler(reqMismatch, resMismatch, () => {});
      assert.equal(capMismatch().code, 403, `${route.name}: Identity mismatch returns HTTP 403`);
      assert.equal(capMismatch().data?.error, 'FORBIDDEN_USER_MISMATCH');
    }
    console.log('  ✓ PASSED: All 5 validation-session routes reject missing, forged, and mismatched auth');
  }

  // --------------------------------------------------------------------------
  // REQUIREMENT 2: User-scoped ValidationSessionManager cross-user isolation
  // --------------------------------------------------------------------------
  console.log('\n[Req 2] User-scoped ValidationSessionManager isolation across multiple users');
  {
    ValidationSessionManager.resetForTest();

    const userA = 'user_alice_8a';
    const userB = 'user_bob_8a';

    // Alice starts a validation session
    const { res: resStartA, getCaptured: capStartA } = createMockRes();
    const reqStartA: any = {
      headers: { authorization: `Bearer ${userA}`, 'x-user-id': userA },
      body: { notes: "Alice's isolated shadow session" },
    };
    await startHandler(reqStartA, resStartA, () => {});
    assert.equal(capStartA().code, 200);
    const aliceSession = capStartA().data.session;
    assert.equal(aliceSession.userId, userA);

    // Bob checks active session: Bob should see NO active session
    const { res: resActiveB, getCaptured: capActiveB } = createMockRes();
    const reqActiveB: any = {
      headers: { authorization: `Bearer ${userB}`, 'x-user-id': userB },
      query: {},
    };
    await activeHandler(reqActiveB, resActiveB, () => {});
    assert.equal(capActiveB().code, 200);
    assert.equal(capActiveB().data.active, false, "Bob does not see Alice's active session");
    assert.equal(capActiveB().data.session, null);

    // Bob attempts to end Alice's session: fails with 400 because Bob has no active session
    const { res: resEndB, getCaptured: capEndB } = createMockRes();
    const reqEndB: any = {
      headers: { authorization: `Bearer ${userB}`, 'x-user-id': userB },
      body: { sessionId: aliceSession.validationSessionId },
    };
    await endHandler(reqEndB, resEndB, () => {});
    assert.equal(capEndB().code, 400, 'Bob cannot end session when he has no active session');
    assert.equal(capEndB().data?.error, 'No active validation session to end');

    // Bob attempts to read report of Alice's session: rejected with 404 (access denied)
    const { res: resReportB, getCaptured: capReportB } = createMockRes();
    const reqReportB: any = {
      headers: { authorization: `Bearer ${userB}`, 'x-user-id': userB },
      query: { sessionId: aliceSession.validationSessionId },
    };
    await reportHandler(reqReportB, resReportB, () => {});
    assert.equal(capReportB().code, 404, 'Bob cannot view Alice session report');
    assert.equal(capReportB().data?.error, 'Validation session not found or access denied');

    // Bob attempts to record observation into Alice's session via manager: rejected with Error
    assert.throws(() => {
      ValidationSessionManager.recordObservation(
        aliceSession.validationSessionId,
        {
          instrument_token: 12345,
          exchange: 'NFO',
          tradingsymbol: 'NIFTY26OCTFUT',
          quantity: 50,
          average_price: 25000,
          last_price: 25100,
          pnl: 5000,
        } as any,
        true,
        undefined,
        undefined,
        new Date(),
        userB // Bob tries to record into Alice's session
      );
    }, /Unauthorized: validation session/);

    // Alice ends her own session: succeeds
    const { res: resEndA, getCaptured: capEndA } = createMockRes();
    const reqEndA: any = {
      headers: { authorization: `Bearer ${userA}`, 'x-user-id': userA },
      body: {},
    };
    await endHandler(reqEndA, resEndA, () => {});
    assert.equal(capEndA().code, 200, 'Alice successfully ends her session');
    assert.equal(capEndA().data.endedSession.endedAt !== null, true);

    // Alice can generate her own report
    const { res: resReportA, getCaptured: capReportA } = createMockRes();
    const reqReportA: any = {
      headers: { authorization: `Bearer ${userA}`, 'x-user-id': userA },
      query: { sessionId: aliceSession.validationSessionId },
    };
    await reportHandler(reqReportA, resReportA, () => {});
    assert.equal(capReportA().code, 200, 'Alice views her own report');
    assert.equal(capReportA().data.session.validationSessionId, aliceSession.validationSessionId);

    console.log('  ✓ PASSED: Validation sessions are strictly isolated between distinct users');
  }

  // --------------------------------------------------------------------------
  // REQUIREMENT 3: Authoritative on-demand recording-state loading across Cloud Run restarts
  // --------------------------------------------------------------------------
  console.log('\n[Req 3] Authoritative live-risk recording-state persistence across Cloud Run restarts');
  {
    resetRecordingStates();

    const restartUser = 'user_restarted_container_42';
    const otherUser = 'user_unactivated_99';

    // Mock Firestore returning enabled = true for restartUser
    let mockDocRequested: string | null = null;
    const mockDb: any = {
      doc: (path: string) => {
        mockDocRequested = path;
        return {
          get: async () => ({
            exists: path.includes(restartUser),
            data: () => ({ enabled: true, userId: restartUser }),
          }),
          set: async () => {},
        };
      },
    };
    setAdminFirestoreForTesting(mockDb);

    try {
      // Memory cache is cold (simulating freshly restarted container instance)
      // Call getLiveRiskStateRecordingEnabled(restartUser)
      const isEnabled = await getLiveRiskStateRecordingEnabled(restartUser);
      assert.equal(isEnabled, true, 'Cold cache loaded authoritative enabled state from Firestore');
      assert.equal(
        mockDocRequested,
        `users/${restartUser}/riskRecording/state`,
        'Requested exact user-scoped Firestore document'
      );

      // Verify other user without Firestore enabled state returns false without global fallback
      const otherEnabled = await getLiveRiskStateRecordingEnabled(otherUser);
      assert.equal(otherEnabled, false, 'Unactivated user returns strictly false with zero global state leak');

      // Verify that subsequent calls use the populated in-memory cache
      assert.equal(await getLiveRiskStateRecordingEnabled(restartUser), true, 'In-memory cache now serves restartUser');
    } finally {
      setAdminFirestoreForTesting(null);
      resetRecordingStates();
    }

    console.log('  ✓ PASSED: On-demand Firestore loading restores per-user recording state across container restarts');
  }

  // --------------------------------------------------------------------------
  // REQUIREMENT 4: Async setLiveRiskStateRecordingEnabled & Fail-Closed Activation
  // --------------------------------------------------------------------------
  console.log('\n[Req 4] Async setLiveRiskStateRecordingEnabled awaits persistence and fails closed on write error');
  {
    resetRecordingStates();
    const failingUser = 'user_firestore_write_fail_1';

    const mockFaultyDb: any = {
      doc: (path: string) => {
        return {
          get: async () => ({ exists: false, data: () => null }),
          set: async () => {
            throw new Error('UNAVAILABLE: Cloud Firestore replica write quorum unavailable');
          },
        };
      },
    };
    setAdminFirestoreForTesting(mockFaultyDb);

    try {
      // Direct call to setLiveRiskStateRecordingEnabled must throw on Firestore write failure
      let writeErrorThrown = false;
      try {
        await setLiveRiskStateRecordingEnabled(true, failingUser);
      } catch (err: any) {
        writeErrorThrown = true;
        assert(err.message.includes('Firestore replica write quorum unavailable'));
      }
      assert.equal(writeErrorThrown, true, 'setLiveRiskStateRecordingEnabled throws when Firestore write fails');

      // In-memory cache must NOT be activated to true when write failed
      assert.equal(
        await getLiveRiskStateRecordingEnabled(failingUser),
        false,
        'Recording state remains strictly false after failed persistence write'
      );

      // Activation control endpoint must fail with HTTP 500 RECORDING_STATE_PERSISTENCE_FAILED
      // First ensure preflight would otherwise pass for failingUser by mocking valid session/config
      await ServerRiskStore.saveConfig(failingUser, { dailyLossLimit: 5000 });
      const { res: resCtrl, getCaptured: capCtrl } = createMockRes();
      const reqCtrl: any = {
        headers: { authorization: `Bearer ${failingUser}`, 'x-user-id': failingUser },
        body: { enabled: true },
      };
      await controlHandler(reqCtrl, resCtrl, () => {});
      // Either preflight blocked or write failed; if write reached, status must be 500
      if (capCtrl().code === 500) {
        assert.equal(capCtrl().data?.error, 'RECORDING_STATE_PERSISTENCE_FAILED');
      } else {
        // Preflight failed closed
        assert([400, 500].includes(capCtrl().code));
      }
    } finally {
      setAdminFirestoreForTesting(null);
      resetRecordingStates();
    }

    console.log('  ✓ PASSED: Activation strictly awaits Firestore persistence and fails closed on write failure');
  }

  // --------------------------------------------------------------------------
  // REQUIREMENT 5: Mock-trader-sandbox strictly gated behind explicit non-production/test condition
  // --------------------------------------------------------------------------
  // REQUIREMENT 5: Sandbox Mode Authentication Gating
  // --------------------------------------------------------------------------
  console.log('\n[Req 5] Mock-trader-sandbox authentication strictly gated; rejected in normal production, allowed only when ENABLE_SANDBOX_MODE=true');
  {
    const originalNodeEnv = process.env.NODE_ENV;
    const originalSandboxFlag = process.env.ENABLE_SANDBOX_MODE;
    const originalAllowAuth = process.env.ALLOW_SANDBOX_AUTH;

    try {
      // 1. In normal production without ENABLE_SANDBOX_MODE: NEVER accept mock-trader-sandbox
      process.env.NODE_ENV = 'production';
      delete (process.env as any).ENABLE_SANDBOX_MODE;
      delete (process.env as any).ALLOW_SANDBOX_AUTH;

      const prodUid = await verifyTokenAndGetUid('mock-trader-sandbox');
      assert.equal(prodUid, null, 'mock-trader-sandbox strictly rejected in normal production deployment');

      const prodPrefixUid = await verifyTokenAndGetUid('mock-trader-sandbox-extension');
      assert.equal(prodPrefixUid, null, 'mock-trader sandbox variant strictly rejected in normal production');

      // 2. In production WITH explicit ENABLE_SANDBOX_MODE=true capability: accepted
      process.env.ENABLE_SANDBOX_MODE = 'true';
      const prodSandboxUid = await verifyTokenAndGetUid('mock-trader-sandbox');
      assert.equal(prodSandboxUid, 'mock-trader-sandbox', 'mock-trader-sandbox accepted when ENABLE_SANDBOX_MODE=true in production');

      // 3. When ENABLE_SANDBOX_MODE is explicitly false: rejected
      process.env.ENABLE_SANDBOX_MODE = 'false';
      const disabledUid = await verifyTokenAndGetUid('mock-trader-sandbox');
      assert.equal(disabledUid, null, 'mock-trader-sandbox rejected when ENABLE_SANDBOX_MODE=false');

      // 4. In development without explicit sandbox flags (with bypassTestCheck: true): rejected
      delete (process.env as any).NODE_ENV;
      delete (process.env as any).ENABLE_SANDBOX_MODE;
      delete (process.env as any).ALLOW_SANDBOX_AUTH;

      const devNoFlagUid = await verifyTokenAndGetUid('mock-trader-sandbox', { bypassTestCheck: true });
      assert.equal(devNoFlagUid, null, 'mock-trader-sandbox rejected without explicit sandbox flag when test bypass active');

      // 5. When explicit sandbox flag enabled: accepted
      process.env.ENABLE_SANDBOX_MODE = 'true';
      const sandboxUid = await verifyTokenAndGetUid('mock-trader-sandbox');
      assert.equal(sandboxUid, 'mock-trader-sandbox', 'mock-trader-sandbox accepted when sandbox flag is explicit');
    } finally {
      process.env.NODE_ENV = originalNodeEnv;
      if (originalSandboxFlag !== undefined) process.env.ENABLE_SANDBOX_MODE = originalSandboxFlag;
      else delete (process.env as any).ENABLE_SANDBOX_MODE;
      if (originalAllowAuth !== undefined) process.env.ALLOW_SANDBOX_AUTH = originalAllowAuth;
      else delete (process.env as any).ALLOW_SANDBOX_AUTH;
    }

    console.log('  ✓ PASSED: mock-trader-sandbox identity strictly gated by server capability flag');
  }

  // --------------------------------------------------------------------------
  // REQUIREMENT 6: Focused Regression Tests for Phase 15 Authority & Persistence
  // --------------------------------------------------------------------------
  console.log('\n[Req 6] Focused Phase 15 Authority & Persistence Regression Tests:');

  // 6.1 Cold-cache recording state
  console.log('  [6.1] Cold-cache recording state');
  {
    resetRecordingStates();
    const coldUser = 'cold_cache_user_regress';
    // When cold, returns a true Promise<boolean> resolving to false
    const promise = getLiveRiskStateRecordingEnabled(coldUser);
    assert(promise instanceof Promise, 'Returns a true Promise');
    const resolved = await promise;
    assert.equal(resolved, false, 'Cold cache resolves to false');

    // LiveRiskRecorder awaits it and does not record when false
    const evalRes = await LiveRiskRecorder.evaluateAndRecordLiveRisk(coldUser);
    assert.equal(evalRes.recorded, false, 'Cold cache does NOT accidentally enable recording');
    console.log('    ✓ PASSED: Cold-cache read returns Promise<boolean> and does not accidentally enable recording');
  }

  // 6.2 Firestore-unavailable activation
  console.log('  [6.2] Firestore-unavailable activation');
  {
    const origEnv = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = 'production';
      enableMockStoreForTesting(false);
      setAdminFirestoreForTesting(null);
      resetRecordingStates();

      let errThrown = false;
      try {
        await setLiveRiskStateRecordingEnabled(true, 'prod_user_without_db');
      } catch (err: any) {
        errThrown = true;
        assert(err.message.includes('RECORDING_STATE_PERSISTENCE_ERROR'), 'Throws RECORDING_STATE_PERSISTENCE_ERROR');
      }
      assert.equal(errThrown, true, 'Activation throws when Firestore unavailable in production');
      assert.equal(await getLiveRiskStateRecordingEnabled('prod_user_without_db'), false, 'Cache not updated');
      console.log('    ✓ PASSED: setLiveRiskStateRecordingEnabled fails closed when Firestore unavailable in production');
    } finally {
      process.env.NODE_ENV = origEnv;
      enableMockStoreForTesting(true);
    }
  }

  // 6.3 Firestore-unavailable RiskEngine persistence
  console.log('  [6.3] Firestore-unavailable RiskEngine persistence');
  {
    const origEnv = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = 'production';
      enableMockStoreForTesting(false);
      setAdminFirestoreForTesting(null);

      const syntheticPnl: any = {
        grossTradingPnl: 1000,
        netPnl: 1000,
        realisedPnl: 1000,
        unrealisedPnl: 0,
        fnoPositionCount: 1,
        totalPositionCount: 1,
        source: 'ZERODHA_LIVE',
        positions: [],
      };

      let evalFailed = false;
      try {
        await ServerRiskStore.evaluatePnlResult('prod_user_no_fs', syntheticPnl);
      } catch (err: any) {
        evalFailed = true;
        assert(err.message.includes('FIRESTORE_PERSISTENCE_FAILURE'), 'Throws FIRESTORE_PERSISTENCE_FAILURE');
      }
      assert.equal(evalFailed, true, 'evaluatePnlResult fails closed when Firestore unavailable in production');

      let configFailed = false;
      try {
        await ServerRiskStore.getConfig('prod_user_no_fs');
      } catch (err: any) {
        configFailed = true;
        assert(err.message.includes('FIRESTORE_READ_FAILURE'), 'Throws FIRESTORE_READ_FAILURE');
      }
      assert.equal(configFailed, true, 'getConfig fails closed without silently synthesizing production config');

      let sessionFailed = false;
      try {
        await ServerRiskStore.getSession('prod_user_no_fs');
      } catch (err: any) {
        sessionFailed = true;
        assert(err.message.includes('FIRESTORE_READ_FAILURE'), 'Throws FIRESTORE_READ_FAILURE');
      }
      assert.equal(sessionFailed, true, 'getSession fails closed without silently synthesizing production session');
      console.log('    ✓ PASSED: ServerRiskStore persistence and state retrieval fail closed in production without Firestore');
    } finally {
      process.env.NODE_ENV = origEnv;
      enableMockStoreForTesting(true);
    }
  }

  // 6.4 Production env-token rejection
  console.log('  [6.4] Production env-token rejection');
  {
    const origEnv = process.env.NODE_ENV;
    const origZerodhaToken = process.env.ZERODHA_ACCESS_TOKEN;
    const origKiteToken = process.env.KITE_ACCESS_TOKEN;

    try {
      process.env.NODE_ENV = 'production';
      process.env.ZERODHA_ACCESS_TOKEN = 'mock_env_token_prod_attack';
      process.env.KITE_ACCESS_TOKEN = 'mock_env_token_prod_attack';

      // Clear cached session
      ZerodhaCredentialManager.setRuntimeSession(null as any);

      const sessionResult = await ZerodhaCredentialManager.getAuthenticatedSession('prod_victim');
      assert.equal(sessionResult, null, 'getAuthenticatedSession rejects env token in production');

      const activeToken = ZerodhaCredentialManager.getActiveAccessToken('prod_victim');
      assert.equal(activeToken, null, 'getActiveAccessToken rejects env token in production');
      console.log('    ✓ PASSED: ZERODHA_ACCESS_TOKEN / KITE_ACCESS_TOKEN strictly rejected in production');
    } finally {
      process.env.NODE_ENV = origEnv;
      if (origZerodhaToken !== undefined) process.env.ZERODHA_ACCESS_TOKEN = origZerodhaToken;
      else delete process.env.ZERODHA_ACCESS_TOKEN;
      if (origKiteToken !== undefined) process.env.KITE_ACCESS_TOKEN = origKiteToken;
      else delete process.env.KITE_ACCESS_TOKEN;
    }
  }

  // 6.5 Missing extension secret rejection
  console.log('  [6.5] Missing extension secret rejection');
  {
    const origSecret = process.env.ZERODHA_API_SECRET;
    try {
      delete process.env.ZERODHA_API_SECRET;

      let tokenErrorThrown = false;
      try {
        generateExtensionToken('extension_user_1');
      } catch (err: any) {
        tokenErrorThrown = true;
        assert(err.message.includes('MISSING_EXTENSION_SECRET'), 'Throws MISSING_EXTENSION_SECRET');
      }
      assert.equal(tokenErrorThrown, true, 'generateExtensionToken throws when ZERODHA_API_SECRET is absent');

      // verifyExtensionToken must return false
      const verifyRes = verifyExtensionToken('extension_user_1', 'abc12345');
      assert.equal(verifyRes, false, 'verifyExtensionToken returns false when secret is absent');
      console.log('    ✓ PASSED: generateExtensionToken fails closed without fallback secret');
    } finally {
      if (origSecret !== undefined) process.env.ZERODHA_API_SECRET = origSecret;
      else delete process.env.ZERODHA_API_SECRET;
    }
  }

  // 6.6 Validation session operations without implicit default identity
  console.log('  [6.6] Validation session operations without implicit default identity');
  {
    ValidationSessionManager.resetForTest();

    // startSession requires userId
    assert.throws(() => {
      ValidationSessionManager.startSession('');
    }, /USER_ID_REQUIRED/);

    // getActiveSession requires userId
    assert.throws(() => {
      ValidationSessionManager.getActiveSession('');
    }, /USER_ID_REQUIRED/);

    // endSession requires userId
    assert.throws(() => {
      ValidationSessionManager.endSession('');
    }, /USER_ID_REQUIRED/);

    // recordObservation requires userId
    assert.throws(() => {
      ValidationSessionManager.recordObservation(
        'dummy_sess',
        { instrument_token: 1, exchange: 'NFO', tradingsymbol: 'T', quantity: 1 } as any,
        true,
        undefined,
        undefined,
        undefined,
        ''
      );
    }, /USER_ID_REQUIRED/);

    // generateReport requires userId
    assert.throws(() => {
      ValidationSessionManager.generateReport('dummy_sess', undefined, '');
    }, /USER_ID_REQUIRED/);

    console.log('    ✓ PASSED: ValidationSessionManager strictly requires userId with zero default_user fallback');
  }

  // --------------------------------------------------------------------------
  // REQUIREMENT 7: RiskConfig Persistence Atomicity & Locked Immutability
  // --------------------------------------------------------------------------
  console.log('\n[Req 7] RiskConfig Persistence Atomicity & Locked Immutability:');

  const atomicityUser = 'user_atomicity_test_1';
  const initialConfig = {
    dailyLossLimit: 5000,
    warningThreshold1: 70,
    warningThreshold2: 85,
    lockDurationMinutes: 120,
    lockDurationType: 'FIXED' as const,
    includeRealisedPnl: true,
    includeUnrealisedPnl: true,
    enabled: true,
  };

  // 7.1 Failed Firestore config write does not alter previous in-memory config
  console.log('  [7.1] Failed Firestore config write leaves in-memory config unchanged');
  {
    // Start with clean initial config in-memory
    setAdminFirestoreForTesting(null);
    enableMockStoreForTesting(true);
    await ServerRiskStore.saveConfig(atomicityUser, initialConfig);
    const beforeConfig = await ServerRiskStore.getConfig(atomicityUser);
    assert.equal(beforeConfig.dailyLossLimit, 5000);

    // Mock faulty Firestore that fails on write
    const mockFaultyDb: any = {
      doc: (path: string) => ({
        get: async () => ({ exists: false, data: () => null }),
        set: async () => {
          throw new Error('UNAVAILABLE: Firestore replica quorum dropped');
        },
      }),
    };
    setAdminFirestoreForTesting(mockFaultyDb);
    enableMockStoreForTesting(false);

    let errThrown = false;
    try {
      await ServerRiskStore.saveConfig(atomicityUser, {
        ...initialConfig,
        dailyLossLimit: 8500, // Attempted modification
      });
    } catch (err: any) {
      errThrown = true;
      assert(err.message.includes('FIRESTORE_PERSISTENCE_FAILURE'));
    }
    assert.equal(errThrown, true, 'saveConfig throws FIRESTORE_PERSISTENCE_FAILURE when write fails');

    // Verify in-memory config was NOT mutated to 8500
    // Temporarily switch back to inspect in-memory userState
    setAdminFirestoreForTesting(null);
    enableMockStoreForTesting(true);
    const afterConfig = await ServerRiskStore.getConfig(atomicityUser);
    assert.equal(afterConfig.dailyLossLimit, 5000, 'dailyLossLimit remains 5000 (unmutated by failed write)');
    console.log('    ✓ PASSED: Failed Firestore write leaves previous in-memory config intact');
  }

  // 7.2 Successful Firestore write updates both persistence and in-memory state
  console.log('  [7.2] Successful Firestore write updates both persistence and in-memory state');
  {
    let persistedDoc: any = null;
    const mockSuccessDb: any = {
      doc: (path: string) => ({
        get: async () => ({ exists: false, data: () => null }),
        set: async (data: any) => {
          persistedDoc = data;
        },
      }),
    };
    setAdminFirestoreForTesting(mockSuccessDb);
    enableMockStoreForTesting(false);

    const updatedInput = {
      ...initialConfig,
      dailyLossLimit: 6500,
      warningThreshold1: 75,
    };
    const res = await ServerRiskStore.saveConfig(atomicityUser, updatedInput);
    assert.equal(res.success, true, 'saveConfig succeeds with valid Firestore');
    assert.equal(res.config?.dailyLossLimit, 6500);

    // Verify Firestore was written
    assert(persistedDoc !== null, 'Firestore set was called');
    assert.equal(persistedDoc.dailyLossLimit, 6500, 'Firestore doc received 6500');

    // Verify in-memory state was updated
    setAdminFirestoreForTesting(null);
    enableMockStoreForTesting(true);
    const cachedConfig = await ServerRiskStore.getConfig(atomicityUser);
    assert.equal(cachedConfig.dailyLossLimit, 6500, 'In-memory config updated to 6500');
    assert.equal(cachedConfig.warningThreshold1, 75, 'In-memory warningThreshold1 updated to 75');
    console.log('    ✓ PASSED: Successful Firestore write updates both persistence and cache');
  }

  // 7.3 Locked config remains immutable
  console.log('  [7.3] Locked config remains immutable while active lock exists');
  {
    setAdminFirestoreForTesting(null);
    enableMockStoreForTesting(true);

    const lockedUser = 'user_locked_immutability_regress';
    await ServerRiskStore.saveConfig(lockedUser, initialConfig);

    // Simulate active LOCKED session
    const today = new Date().toISOString().split('T')[0];
    const activeLockSession = {
      tradingDate: today,
      userId: lockedUser,
      state: 'LOCKED' as const,
      isBreached: true,
      lockedAt: new Date().toISOString(),
      lockUntil: new Date(Date.now() + 60 * 60 * 1000).toISOString(), // 1 hour in future
      currentPnl: -6000,
      lossAmount: 6000,
      realisedPnl: -6000,
      unrealisedPnl: 0,
      lossLimit: 5000,
      warningThreshold1: 70,
      warningThreshold2: 85,
      lastEvaluatedAt: new Date().toISOString(),
      reason: 'Daily loss limit breach',
    };
    (ServerRiskStore as any).getOrCreateUserState(lockedUser).sessions.set(today, activeLockSession);

    // 1. Attempt to change dailyLossLimit while locked
    const limitMutationRes = await ServerRiskStore.saveConfig(lockedUser, {
      ...initialConfig,
      dailyLossLimit: 12000,
    });
    assert.equal(limitMutationRes.success, false, 'Mutating dailyLossLimit rejected while locked');
    assert.equal(limitMutationRes.code, 'RISK_CONFIG_LOCKED');
    const configAfterLimit = await ServerRiskStore.getConfig(lockedUser);
    assert.equal(configAfterLimit.dailyLossLimit, 5000, 'dailyLossLimit remains 5000');

    // 2. Attempt to change lockDurationMinutes while locked
    const durationMutationRes = await ServerRiskStore.saveConfig(lockedUser, {
      ...initialConfig,
      lockDurationMinutes: 180,
    });
    assert.equal(durationMutationRes.success, false, 'Mutating lockDurationMinutes rejected while locked');
    assert.equal(durationMutationRes.code, 'RISK_CONFIG_LOCKED');
    const configAfterDuration = await ServerRiskStore.getConfig(lockedUser);
    assert.equal(configAfterDuration.lockDurationMinutes, 120, 'lockDurationMinutes remains 120');

    // 3. Warning thresholds remain editable while locked
    const warningMutationRes = await ServerRiskStore.saveConfig(lockedUser, {
      ...initialConfig,
      warningThreshold1: 72,
      warningThreshold2: 88,
    });
    assert.equal(warningMutationRes.success, true, 'Warning thresholds can be updated while locked');
    const configAfterWarning = await ServerRiskStore.getConfig(lockedUser);
    assert.equal(configAfterWarning.warningThreshold1, 72, 'warningThreshold1 updated to 72');
    assert.equal(configAfterWarning.warningThreshold2, 88, 'warningThreshold2 updated to 88');
    assert.equal(configAfterWarning.dailyLossLimit, 5000, 'dailyLossLimit remained 5000');
    console.log('    ✓ PASSED: Locked config immutability strictly preserved');
  }

  console.log('\n================================================================');
  console.log('ALL PHASE 15 SECURITY REGRESSION REQUIREMENTS VERIFIED');
  console.log('================================================================');
}

runPhase15SecuritySuite().catch((err) => {
  console.error('\nPhase 15 Security Suite Error:', err);
  process.exit(1);
});
