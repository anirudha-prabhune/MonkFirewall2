import { strict as assert } from 'assert';
import { apiRouter } from '../server/api';
import { ValidationSessionManager } from '../server/pnl/validationSession';
import {
  getLiveRiskStateRecordingEnabled,
  setLiveRiskStateRecordingEnabled,
  resetRecordingStates,
} from '../server/risk/liveRiskRecorder';
import { verifyTokenAndGetUid } from '../server/auth/session';
import { getAdminFirestore, setAdminFirestoreForTesting } from '../server/brokers/zerodha/sessionStore';
import { ServerRiskStore } from '../server/risk/store';

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
      assert.equal(getLiveRiskStateRecordingEnabled(restartUser), true, 'In-memory cache now serves restartUser');
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
  console.log('\n[Req 5] Mock-trader-sandbox authentication strictly gated; never accepted in production');
  {
    const originalNodeEnv = process.env.NODE_ENV;
    const originalSandboxFlag = process.env.ENABLE_SANDBOX_MODE;
    const originalAllowAuth = process.env.ALLOW_SANDBOX_AUTH;

    try {
      // 1. In production: NEVER accept mock-trader-sandbox under any condition, even if sandbox flags set
      process.env.NODE_ENV = 'production';
      process.env.ENABLE_SANDBOX_MODE = 'true';
      process.env.ALLOW_SANDBOX_AUTH = 'true';

      const prodUid = await verifyTokenAndGetUid('mock-trader-sandbox');
      assert.equal(prodUid, null, 'mock-trader-sandbox strictly rejected in production');

      const prodPrefixUid = await verifyTokenAndGetUid('mock-trader-sandbox-extension');
      assert.equal(prodPrefixUid, null, 'mock-trader sandbox variant strictly rejected in production');

      // 2. In development without explicit sandbox flags: rejected
      delete (process.env as any).NODE_ENV;
      delete (process.env as any).ENABLE_SANDBOX_MODE;
      delete (process.env as any).ALLOW_SANDBOX_AUTH;

      // In unit test runner (where argv includes 'test'), sandbox mode is allowed during tests
      // When bypassTestCheck: true is passed, it simulates non-test environment
      const devNoFlagUid = await verifyTokenAndGetUid('mock-trader-sandbox', { bypassTestCheck: true });
      assert.equal(devNoFlagUid, null, 'mock-trader-sandbox rejected without explicit sandbox flag');

      // 3. When explicit sandbox flag enabled outside production: accepted
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

    console.log('  ✓ PASSED: mock-trader-sandbox identity strictly gated and unconditionally rejected in production');
  }

  console.log('\n================================================================');
  console.log('ALL 5 PHASE 15 SECURITY REGRESSION REQUIREMENTS VERIFIED (5/5)');
  console.log('================================================================');
}

runPhase15SecuritySuite().catch((err) => {
  console.error('\nPhase 15 Security Suite Error:', err);
  process.exit(1);
});
