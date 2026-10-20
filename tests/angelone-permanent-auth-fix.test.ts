import { strict as assert } from 'assert';
import { liveAngelOneAdapter } from '../server/brokers/angelone/liveAdapter';
import {
  AngelOneSessionStore,
  inMemoryTestApiKeyStore,
  inMemoryTestStore,
  inMemoryTestCredentialsStore,
} from '../server/brokers/angelone/sessionStore';

async function runPermanentAuthFixTestSuite() {
  console.log('================================================================');
  console.log('MonkFirewall2: Permanent Angel One Authentication & Polling Suite');
  console.log('================================================================\n');

  AngelOneSessionStore.enableMockStoreForTesting(true);

  const userId = 'trader_perm_fix_101';
  const connId = 'acc_mt_angelone_default';
  const testApiKey = 'USER_ACCOUNT_API_KEY_12345';
  const testClientCode = 'A123456';
  const testPassword = 'Password123';
  const testTotp = '123456';

  let outboundCalls: Array<{ url: string; headers: Record<string, string> }> = [];

  // Mock fetch handler simulating upstream SmartAPI
  const mockSmartApiFetch = async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : input.toString();
    const headers = (init?.headers || {}) as Record<string, string>;
    outboundCalls.push({ url, headers });

    // Login endpoint
    if (url.includes('/loginByPassword')) {
      const body = JSON.parse(init?.body || '{}');
      if (headers['X-PrivateKey'] === testApiKey && body.clientcode === testClientCode) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            status: true,
            message: 'SUCCESS',
            errorcode: '',
            data: {
              jwtToken: 'Bearer mock_valid_jwt_token_for_user_account_1234567890',
              refreshToken: 'mock_refresh_token_12345',
            },
          }),
        } as any;
      }
      return {
        ok: false,
        status: 400,
        json: async () => ({ status: false, message: 'Invalid Credentials', errorcode: 'AB1001' }),
      } as any;
    }

    // Get Positions endpoint
    if (url.includes('/getPosition')) {
      const authHeader = headers['Authorization'] || '';
      const xPrivateKey = headers['X-PrivateKey'] || '';

      // SmartAPI requires X-PrivateKey to match the stored user account key
      if (xPrivateKey !== testApiKey) {
        return {
          ok: false,
          status: 403,
          json: async () => ({ status: false, message: 'Invalid Private Key / Key Mismatch', errorcode: 'AB1010' }),
        } as any;
      }

      if (!authHeader.includes('mock_valid_jwt_token')) {
        return {
          ok: false,
          status: 403,
          json: async () => ({ status: false, message: 'Invalid or Expired Token', errorcode: 'AG8002' }),
        } as any;
      }

      return {
        ok: true,
        status: 200,
        json: async () => ({
          status: true,
          message: 'SUCCESS',
          errorcode: '',
          data: [
            {
              exchange: 'NFO',
              tradingsymbol: 'NIFTY26OCT24000CE',
              producttype: 'CARRYFORWARD',
              netqty: '50',
              avgprice: '120.5',
              ltp: '145.0',
              pnl: '1225.0',
              symboltoken: '45001',
            },
          ],
        }),
      } as any;
    }

    // Get RMS Capital endpoint
    if (url.includes('/getRMS')) {
      const authHeader = headers['Authorization'] || '';
      const xPrivateKey = headers['X-PrivateKey'] || '';

      if (xPrivateKey !== testApiKey) {
        return {
          ok: false,
          status: 403,
          json: async () => ({ status: false, message: 'Invalid Private Key', errorcode: 'AB1010' }),
        } as any;
      }

      if (!authHeader.includes('mock_valid_jwt_token')) {
        return {
          ok: false,
          status: 403,
          json: async () => ({ status: false, message: 'Invalid Token', errorcode: 'AG8002' }),
        } as any;
      }

      return {
        ok: true,
        status: 200,
        json: async () => ({
          status: true,
          message: 'SUCCESS',
          errorcode: '',
          data: {
            net: '250000.00',
            availablecash: '200000.00',
            utiliseddebits: '50000.00',
          },
        }),
      } as any;
    }

    return { ok: false, status: 404, json: async () => ({ status: false, message: 'Not Found' }) } as any;
  };

  liveAngelOneAdapter.setFetchHandler(mockSmartApiFetch);

  // --------------------------------------------------------------------------
  // TEST 1: Successful Login Followed by Repeated 10-Second Polling Cycles
  // --------------------------------------------------------------------------
  console.log('[Test 1] Login & Repeated Positions/RMS Polling Lifecycle');
  {
    outboundCalls = [];
    const authResult = await liveAngelOneAdapter.authenticate(
      userId,
      {
        apiKey: testApiKey,
        clientCode: testClientCode,
        password: testPassword,
        totp: testTotp,
      },
      { connectionId: connId }
    );

    assert.equal(authResult.success, true, 'Login must succeed with valid TOTP & API Key');

    // Perform 5 consecutive polling cycles
    for (let poll = 1; poll <= 5; poll++) {
      const status = await liveAngelOneAdapter.getConnectionStatus(userId, { connectionId: connId });
      assert.equal(status.status, 'AUTHENTICATED', `Poll #${poll}: Connection status must be AUTHENTICATED`);
      assert.equal(status.authenticated, true, `Poll #${poll}: Must be marked authenticated`);

      const positions = await liveAngelOneAdapter.getPositions(userId, { connectionId: connId });
      assert.equal(positions.length, 1, `Poll #${poll}: Must fetch 1 position`);
      assert.equal(positions[0].tradingsymbol, 'NIFTY26OCT24000CE');

      const capital = await liveAngelOneAdapter.getCapital(userId, { connectionId: connId });
      assert.equal(capital.connectionStatus, 'AUTHENTICATED', `Poll #${poll}: Capital status must be AUTHENTICATED`);
      assert.equal(capital.netBalance, 250000, `Poll #${poll}: Capital netBalance must match SmartAPI response`);
    }

    // Verify all outbound requests used the stored account API key
    const positionCalls = outboundCalls.filter((c) => c.url.includes('/getPosition'));
    assert.equal(positionCalls.length, 5, 'Must execute 5 position fetches');
    for (const call of positionCalls) {
      assert.equal(call.headers['X-PrivateKey'], testApiKey, 'All position calls MUST use the user account stored API key');
    }

    console.log('  ✓ PASSED: Login succeeds and 5 consecutive polling cycles fetch Positions/RMS without 403 or invalidation');
  }

  // --------------------------------------------------------------------------
  // TEST 2: Genuine Invalid-Session Rejection & Polling Termination
  // --------------------------------------------------------------------------
  console.log('\n[Test 2] Genuine Invalid-Session Rejection & Polling Circuit Breaker');
  {
    outboundCalls = [];

    // Inject expired token response
    liveAngelOneAdapter.setFetchHandler(async (input: any, init?: any) => {
      const url = typeof input === 'string' ? input : input.toString();
      outboundCalls.push({ url, headers: (init?.headers || {}) as any });

      if (url.includes('/getPosition')) {
        return {
          ok: false,
          status: 403,
          json: async () => ({ status: false, message: 'Session Expired or Unauthorized', errorcode: 'AG8002' }),
        } as any;
      }
      return { ok: true, status: 200, json: async () => ({ status: true }) } as any;
    });

    // Positions fetch must throw error and trigger session invalidation
    await assert.rejects(
      async () => {
        await liveAngelOneAdapter.getPositions(userId, { connectionId: connId });
      },
      /SmartAPI getPosition/i,
      'Invalid token must throw SmartAPI getPosition error'
    );

    const callsCountBeforePolling = outboundCalls.length;

    // Subsequent 3 polling attempts MUST fail-closed locally with AUTHENTICATION_REQUIRED and NOT hit upstream network
    for (let poll = 1; poll <= 3; poll++) {
      const status = await liveAngelOneAdapter.getConnectionStatus(userId, { connectionId: connId });
      assert.equal(status.status, 'AUTHENTICATION_REQUIRED', `Poll #${poll}: Status MUST report AUTHENTICATION_REQUIRED`);
      assert.equal(status.authenticated, false, `Poll #${poll}: Authenticated MUST be false`);

      await assert.rejects(
        async () => {
          await liveAngelOneAdapter.getPositions(userId, { connectionId: connId });
        },
        /positions unavailable/i,
        `Poll #${poll}: Positions call MUST fail closed locally without network request`
      );
    }

    // Verify zero additional network calls were dispatched during polling
    assert.equal(outboundCalls.length, callsCountBeforePolling, 'Polling MUST NOT dispatch upstream network calls once AUTHENTICATION_REQUIRED');

    console.log('  ✓ PASSED: Genuine session expiry halts upstream polling and transitions connection status to AUTHENTICATION_REQUIRED');
  }

  // --------------------------------------------------------------------------
  // TEST 3: Missing / Mismatched Account Credentials Fail-Closed (No Global Fallback)
  // --------------------------------------------------------------------------
  console.log('\n[Test 3] Fail-Closed Behavior for Missing/Mismatched Account Credentials');
  {
    const prodUser = 'trader_prod_credentials_102';
    const originalEnv = process.env.NODE_ENV;
    const originalKey = process.env.SESSION_ENCRYPTION_KEY;

    process.env.NODE_ENV = 'production';
    process.env.SESSION_ENCRYPTION_KEY = '0'.repeat(64);

    try {
      // Save authenticated session doc BUT no API key doc
      await AngelOneSessionStore.saveSession(prodUser, 'mock_prod_jwt_token_1234567890', { connectionId: connId });

      // Ensure no stored API key exists in store
      const apiKeyDocPath = AngelOneSessionStore.getApiKeyDocPath(prodUser, connId);
      inMemoryTestApiKeyStore.delete(apiKeyDocPath);

      const status = await liveAngelOneAdapter.getConnectionStatus(prodUser, { connectionId: connId });
      assert.equal(status.status, 'CONFIGURATION_ERROR', 'Missing stored API key in production MUST return CONFIGURATION_ERROR');
      assert.equal(status.authenticated, false);

      await assert.rejects(
        async () => {
          await liveAngelOneAdapter.getPositions(prodUser, { connectionId: connId });
        },
        /positions unavailable/i,
        'getPositions MUST fail closed when account API key is missing'
      );

      console.log('  ✓ PASSED: Production mode fails closed safely without falling back to global server env key');
    } finally {
      process.env.NODE_ENV = originalEnv;
      if (originalKey) {
        process.env.SESSION_ENCRYPTION_KEY = originalKey;
      } else {
        delete process.env.SESSION_ENCRYPTION_KEY;
      }
    }
  }

  // --------------------------------------------------------------------------
  // TEST 4: Explicit Re-authentication Recovery & Polling Resume
  // --------------------------------------------------------------------------
  console.log('\n[Test 4] Re-Authentication Recovery & Polling Resume');
  {
    outboundCalls = [];
    liveAngelOneAdapter.setFetchHandler(mockSmartApiFetch);

    // Verify connection status initially requires auth
    const statusBefore = await liveAngelOneAdapter.getConnectionStatus(userId, { connectionId: connId });
    assert.equal(statusBefore.status, 'AUTHENTICATION_REQUIRED', 'Connection state must start at AUTHENTICATION_REQUIRED');

    // Execute explicit re-authentication
    const reauthResult = await liveAngelOneAdapter.authenticate(
      userId,
      {
        apiKey: testApiKey,
        clientCode: testClientCode,
        password: testPassword,
        totp: testTotp,
      },
      { connectionId: connId }
    );

    assert.equal(reauthResult.success, true, 'Re-authentication MUST succeed');

    // Post-reauth status MUST be AUTHENTICATED
    const statusAfter = await liveAngelOneAdapter.getConnectionStatus(userId, { connectionId: connId });
    assert.equal(statusAfter.status, 'AUTHENTICATED', 'Re-authenticated status MUST be AUTHENTICATED');

    // Positions & RMS polling MUST resume and succeed
    const positions = await liveAngelOneAdapter.getPositions(userId, { connectionId: connId });
    assert.equal(positions.length, 1, 'Positions fetch MUST succeed post re-authentication');

    const capital = await liveAngelOneAdapter.getCapital(userId, { connectionId: connId });
    assert.equal(capital.connectionStatus, 'AUTHENTICATED', 'Capital fetch MUST succeed post re-authentication');

    console.log('  ✓ PASSED: Explicit re-authentication clears auth-required state and successfully resumes polling');
  }

  console.log('\n================================================================');
  console.log('ALL PERMANENT AUTH & POLLING FIX TESTS PASSED (4/4)');
  console.log('================================================================\n');
}

runPermanentAuthFixTestSuite().catch((err) => {
  console.error('Test Suite Failed:', err);
  process.exit(1);
});
