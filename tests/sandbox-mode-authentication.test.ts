import { strict as assert } from 'assert';
import express from 'express';
import { apiRouter } from '../server/api';
import {
  verifyTokenAndGetUid,
  authenticateRequest,
  isSandboxModeEnabled,
} from '../server/auth/session';
import { ServerRiskStore } from '../server/risk/store';
import { BrokerService } from '../server/brokers/service';
import { ZerodhaCredentialManager } from '../server/brokers/zerodha/credentials';

async function invokeExpress(
  app: express.Express,
  options: {
    method: 'GET' | 'POST' | 'PUT';
    url: string;
    headers?: Record<string, string>;
    body?: any;
  }
) {
  let capturedCode = 200;
  let capturedData: any = null;

  const req: any = {
    method: options.method,
    url: options.url,
    originalUrl: options.url,
    baseUrl: '',
    path: options.url.split('?')[0],
    query: {},
    headers: { ...(options.headers || {}) },
    body: options.body || {},
  };

  const res: any = {
    statusCode: 200,
    status: (code: number) => {
      capturedCode = code;
      res.statusCode = code;
      return res;
    },
    json: (data: any) => {
      capturedData = data;
      return res;
    },
    setHeader: () => res,
    send: (data: any) => {
      capturedData = data;
      return res;
    },
    end: () => res,
  };

  await new Promise<void>((resolve, reject) => {
    app(req, res, (err: any) => {
      if (err) reject(err);
      else resolve();
    });
  });

  return { code: capturedCode, data: capturedData };
}

async function runSandboxAuthTestSuite() {
  console.log('================================================================');
  console.log('TRADING FIREWALL: SANDBOX MODE AUTHENTICATION & SECURITY SUITE');
  console.log('Explicit Capability Flags, Security Boundaries & Isolation');
  console.log('================================================================\n');

  const app = express();
  app.use(express.json());
  app.use('/api', apiRouter);

  const originalNodeEnv = process.env.NODE_ENV;
  const originalSandboxFlag = process.env.ENABLE_SANDBOX_MODE;
  const originalAllowAuth = process.env.ALLOW_SANDBOX_AUTH;

  try {
    // --------------------------------------------------------------------------
    // TEST A: Exact sandbox token accepted when ENABLE_SANDBOX_MODE=true
    // --------------------------------------------------------------------------
    console.log('[Test A] Exact sandbox token accepted when enabled (ENABLE_SANDBOX_MODE=true)');
    {
      process.env.NODE_ENV = 'production';
      process.env.ENABLE_SANDBOX_MODE = 'true';
      delete (process.env as any).ALLOW_SANDBOX_AUTH;

      assert.equal(isSandboxModeEnabled(), true, 'isSandboxModeEnabled() returns true when ENABLE_SANDBOX_MODE=true');

      const uid = await verifyTokenAndGetUid('mock-trader-sandbox');
      assert.equal(uid, 'mock-trader-sandbox', 'verifyTokenAndGetUid returns mock-trader-sandbox');

      const res = await invokeExpress(app, {
        method: 'GET',
        url: '/api/risk/config',
        headers: {
          authorization: 'Bearer mock-trader-sandbox',
        },
      });

      assert.equal(res.code, 200, 'GET /api/risk/config returns 200 for authenticated sandbox user');
      assert.ok(res.data.dailyLossLimit !== undefined, 'Returned risk config for sandbox user');
      console.log('  ✓ PASSED: Exact mock-trader-sandbox authenticated successfully when ENABLE_SANDBOX_MODE=true');
    }

    // --------------------------------------------------------------------------
    // TEST B: Sandbox token prefix variants strictly rejected when enabled
    // --------------------------------------------------------------------------
    console.log('\n[Test B] Sandbox token prefix variants rejected even when ENABLE_SANDBOX_MODE=true');
    {
      process.env.NODE_ENV = 'production';
      process.env.ENABLE_SANDBOX_MODE = 'true';

      const attackerUid = await verifyTokenAndGetUid('mock-trader-sandbox-attacker');
      assert.equal(attackerUid, null, 'mock-trader-sandbox-attacker is strictly rejected');

      const extensionUid = await verifyTokenAndGetUid('mock-trader-sandbox-extension');
      assert.equal(extensionUid, null, 'mock-trader-sandbox-extension is strictly rejected');

      const numericUid = await verifyTokenAndGetUid('mock-trader-sandbox123');
      assert.equal(numericUid, null, 'mock-trader-sandbox123 is strictly rejected');

      const attackerRes = await invokeExpress(app, {
        method: 'GET',
        url: '/api/risk/config',
        headers: {
          authorization: 'Bearer mock-trader-sandbox-attacker',
        },
      });
      assert.equal(attackerRes.code, 401, 'Prefix variant returns 401 UNAUTHENTICATED');
      assert.equal(attackerRes.data.error, 'UNAUTHENTICATED');

      const extensionRes = await invokeExpress(app, {
        method: 'GET',
        url: '/api/risk/config',
        headers: {
          authorization: 'Bearer mock-trader-sandbox-extension',
        },
      });
      assert.equal(extensionRes.code, 401, 'Extension prefix variant returns 401 UNAUTHENTICATED');

      console.log('  ✓ PASSED: All mock-trader-sandbox prefix variants strictly rejected');
    }

    // --------------------------------------------------------------------------
    // TEST C: ALLOW_SANDBOX_AUTH alone cannot enable sandbox authentication
    // --------------------------------------------------------------------------
    console.log('\n[Test C] ALLOW_SANDBOX_AUTH alone cannot enable sandbox authentication in production');
    {
      process.env.NODE_ENV = 'production';
      delete (process.env as any).ENABLE_SANDBOX_MODE;
      process.env.ALLOW_SANDBOX_AUTH = 'true';

      assert.equal(isSandboxModeEnabled(), false, 'isSandboxModeEnabled() returns false when only ALLOW_SANDBOX_AUTH=true');

      const uid = await verifyTokenAndGetUid('mock-trader-sandbox');
      assert.equal(uid, null, 'verifyTokenAndGetUid returns null when only ALLOW_SANDBOX_AUTH is present');

      const res = await invokeExpress(app, {
        method: 'GET',
        url: '/api/risk/config',
        headers: {
          authorization: 'Bearer mock-trader-sandbox',
        },
      });

      assert.equal(res.code, 401, 'GET /api/risk/config returns 401 with ALLOW_SANDBOX_AUTH alone');
      assert.equal(res.data.error, 'UNAUTHENTICATED');

      // Also verify when ENABLE_SANDBOX_MODE=false and ALLOW_SANDBOX_AUTH=true
      process.env.ENABLE_SANDBOX_MODE = 'false';
      assert.equal(isSandboxModeEnabled(), false, 'isSandboxModeEnabled() returns false with ENABLE_SANDBOX_MODE=false');
      const uidFalse = await verifyTokenAndGetUid('mock-trader-sandbox');
      assert.equal(uidFalse, null, 'verifyTokenAndGetUid returns null with ENABLE_SANDBOX_MODE=false');

      console.log('  ✓ PASSED: Single capability flag enforced; legacy/alternate flag ignored');
    }

    // --------------------------------------------------------------------------
    // TEST D: Production normal deployment (no sandbox flag) -> mock-trader-sandbox -> 401
    // --------------------------------------------------------------------------
    console.log('\n[Test D] Production normal deployment (no sandbox flag) -> mock-trader-sandbox -> 401');
    {
      process.env.NODE_ENV = 'production';
      delete (process.env as any).ENABLE_SANDBOX_MODE;
      delete (process.env as any).ALLOW_SANDBOX_AUTH;

      assert.equal(isSandboxModeEnabled(), false, 'isSandboxModeEnabled() returns false in normal production');

      const uid = await verifyTokenAndGetUid('mock-trader-sandbox');
      assert.equal(uid, null, 'verifyTokenAndGetUid returns null in normal production');

      const res = await invokeExpress(app, {
        method: 'GET',
        url: '/api/risk/config',
        headers: {
          authorization: 'Bearer mock-trader-sandbox',
        },
      });

      assert.equal(res.code, 401, 'GET /api/risk/config returns 401 in normal production deployment');
      assert.equal(res.data.error, 'UNAUTHENTICATED', 'Returns UNAUTHENTICATED error');
      console.log('  ✓ PASSED: mock-trader-sandbox NEVER authenticates on normal production deployment');
    }

    // --------------------------------------------------------------------------
    // TEST D: Authenticated sandbox user can POST /api/risk/evaluate with pnl
    // --------------------------------------------------------------------------
    console.log('\n[Test D] Authenticated sandbox user can POST /api/risk/evaluate with synthetic pnl');
    {
      process.env.NODE_ENV = 'production';
      process.env.ENABLE_SANDBOX_MODE = 'true';

      const res = await invokeExpress(app, {
        method: 'POST',
        url: '/api/risk/evaluate',
        headers: {
          authorization: 'Bearer mock-trader-sandbox',
          'content-type': 'application/json',
        },
        body: { pnl: -6000 },
      });

      assert.equal(res.code, 200, 'POST /api/risk/evaluate returns 200');
      assert.equal(res.data.state, 'LOCKED', 'Simulation evaluates breach and returns LOCKED state');
      assert.equal(res.data.currentPnl, -6000, 'Current PnL reflects simulated target value');
      assert.ok(res.data.session !== undefined, 'Returns authoritative session object');
      console.log('  ✓ PASSED: Sandbox user successfully executes synthetic P&L simulation');
    }

    // --------------------------------------------------------------------------
    // TEST E: Authenticated sandbox user can POST /api/risk/evaluate with reset
    // --------------------------------------------------------------------------
    console.log('\n[Test E] Authenticated sandbox user can POST /api/risk/evaluate with reset');
    {
      process.env.NODE_ENV = 'production';
      process.env.ENABLE_SANDBOX_MODE = 'true';

      const res = await invokeExpress(app, {
        method: 'POST',
        url: '/api/risk/evaluate',
        headers: {
          authorization: 'Bearer mock-trader-sandbox',
          'content-type': 'application/json',
        },
        body: { reset: true },
      });

      assert.equal(res.code, 200, 'POST /api/risk/evaluate reset returns 200');
      assert.equal(res.data.success, true, 'Reset returned success: true');
      assert.equal(res.data.state, 'ALLOW', 'Session reset to baseline ALLOW state');
      assert.equal(res.data.currentPnl, 0, 'Current PnL reset to 0');
      console.log('  ✓ PASSED: Sandbox user successfully executes demo state reset');
    }

    // --------------------------------------------------------------------------
    // TEST F: Real Firebase authentication remains unchanged
    // --------------------------------------------------------------------------
    console.log('\n[Test F] Real Firebase authentication remains unchanged and verified');
    {
      process.env.NODE_ENV = 'test';
      delete (process.env as any).ENABLE_SANDBOX_MODE;

      const realUid = await verifyTokenAndGetUid('verified_firebase_user_789');
      assert.equal(realUid, 'verified_firebase_user_789', 'Real user token verifies to user UID');

      // Invalid tokens must be rejected
      const invalidUid = await verifyTokenAndGetUid('invalid_token_xyz');
      assert.equal(invalidUid, null, 'Invalid token rejected');

      const forgedUid = await verifyTokenAndGetUid('forged_signature_token');
      assert.equal(forgedUid, null, 'Forged token rejected');

      console.log('  ✓ PASSED: Firebase authentication verification pipeline intact and secure');
    }

    // --------------------------------------------------------------------------
    // TEST G: Sandbox cannot access live Zerodha credentials/data, other users, or trading
    // --------------------------------------------------------------------------
    console.log('\n[Test G] Sandbox identity security boundary and isolation');
    {
      process.env.NODE_ENV = 'production';
      process.env.ENABLE_SANDBOX_MODE = 'true';

      // 1. Cross-user spoofing prevention: Sandbox bearer token with mismatched x-user-id header
      const mismatchRes = await invokeExpress(app, {
        method: 'GET',
        url: '/api/risk/config',
        headers: {
          authorization: 'Bearer mock-trader-sandbox',
          'x-user-id': 'real_live_trader_123',
        },
      });
      assert.equal(mismatchRes.code, 403, 'Cross-user x-user-id mismatch is rejected with 403');
      assert.equal(mismatchRes.data.error, 'FORBIDDEN_USER_MISMATCH', 'Error code is FORBIDDEN_USER_MISMATCH');

      // 2. Zerodha live connection status for sandbox identity shows unauthenticated
      const liveStatus = await BrokerService.getLiveDiagnosticStatus('mock-trader-sandbox');
      assert.equal(liveStatus.authenticated, false, 'Sandbox user has no live Zerodha authentication');

      // 3. Live recording activation preflight fails for sandbox identity
      const recordingRes = await invokeExpress(app, {
        method: 'POST',
        url: '/api/risk/recording/control',
        headers: {
          authorization: 'Bearer mock-trader-sandbox',
          'content-type': 'application/json',
        },
        body: { enabled: true },
      });
      assert.equal(recordingRes.code, 400, 'Live recording activation blocked by preflight checks');
      assert.equal(recordingRes.data.error, 'PREFLIGHT_CHECK_FAILED', 'Preflight check failed for sandbox user');

      // 4. Broker enforcement contract requires cryptographic extension token signed with secret
      const brokerContractRes = await invokeExpress(app, {
        method: 'GET',
        url: '/api/enforcement/broker',
        headers: {
          'x-user-id': 'mock-trader-sandbox',
          'x-extension-token': 'invalid_token',
        },
      });
      assert.equal(brokerContractRes.code, 401, 'Unauthorized extension call rejected');

      console.log('  ✓ PASSED: Sandbox identity strictly bounded with zero access to live Zerodha, other users, or live trading');
    }

  } finally {
    process.env.NODE_ENV = originalNodeEnv;
    if (originalSandboxFlag !== undefined) process.env.ENABLE_SANDBOX_MODE = originalSandboxFlag;
    else delete (process.env as any).ENABLE_SANDBOX_MODE;
    if (originalAllowAuth !== undefined) process.env.ALLOW_SANDBOX_AUTH = originalAllowAuth;
    else delete (process.env as any).ALLOW_SANDBOX_AUTH;
  }

  console.log('\n================================================================');
  console.log('ALL SANDBOX MODE AUTHENTICATION & SECURITY REGRESSION TESTS PASSED');
  console.log('================================================================\n');
}

runSandboxAuthTestSuite().catch((err) => {
  console.error('Test suite failed:', err);
  process.exit(1);
});
