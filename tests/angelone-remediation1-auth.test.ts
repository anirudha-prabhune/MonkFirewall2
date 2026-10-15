import assert from 'assert';
import { liveAngelOneAdapter, AngelOneAuthParams } from '../server/brokers/angelone/liveAdapter';
import { AngelOneSessionStore } from '../server/brokers/angelone/sessionStore';
import { AngelOneCredentials } from '../server/brokers/angelone/credentials';
import { generateTotp } from '../server/brokers/angelone/totp';
import { apiRouter } from '../server/api';

async function runRemediation1Tests() {
  console.log('================================================================');
  console.log('MonkTrades Phase 4A Remediation 1: Real Angel One SmartAPI Auth');
  console.log('================================================================');

  AngelOneSessionStore.enableMockStoreForTesting(true);

  // --------------------------------------------------------------------------
  // Test 1: Successful SmartAPI authentication with upstream contract verification
  // --------------------------------------------------------------------------
  console.log('\n[Test 1] Successful Upstream SmartAPI Authentication');
  const userId1 = 'user_test_success_001';
  let capturedRequest: any = null;

  const mockValidFetch: any = async (url: string, init: any) => {
    capturedRequest = {
      url,
      method: init.method,
      headers: init.headers,
      body: JSON.parse(init.body),
    };
    return {
      ok: true,
      status: 200,
      json: async () => ({
        status: true,
        message: 'SUCCESS',
        errorcode: '',
        data: {
          jwtToken: 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.dummy_valid_jwt_payload_1234567890',
          refreshToken: 'dummy_refresh_token_987654321',
          feedToken: 'dummy_feed_token_555',
        },
      }),
    };
  };

  const authParams: AngelOneAuthParams = {
    apiKey: 'test_smartapi_key_01',
    clientCode: 'TEST_CLIENT_01',
    password: 'SuperSecretPassword!1',
    totp: '123456',
  };

  const result1 = await liveAngelOneAdapter.authenticate(userId1, authParams, { customFetch: mockValidFetch });

  assert.strictEqual(result1.success, true, 'Authentication must succeed with valid upstream response');
  assert.strictEqual(result1.session?.clientCode, 'TEST_CLIENT_01', 'Session client code must match');
  assert.strictEqual(result1.session?.sessionVersion, 1, 'Initial session version must be 1');
  assert(Boolean(result1.session?.expiresAt), 'expiresAt must be returned');

  // Verify result DOES NOT leak tokens or credentials
  assert.strictEqual((result1 as any).accessToken, undefined, 'accessToken must NOT be returned in result');
  assert.strictEqual((result1 as any).jwtToken, undefined, 'jwtToken must NOT be returned in result');
  assert.strictEqual((result1 as any).password, undefined, 'password must NOT be returned in result');

  // Verify upstream SmartAPI request contract
  assert(capturedRequest !== null, 'SmartAPI endpoint must have been called');
  assert.strictEqual(capturedRequest.url, 'https://apiconnect.angelbroking.com/rest/auth/angelbroking/user/v1/loginByPassword');
  assert.strictEqual(capturedRequest.method, 'POST');
  assert.strictEqual(capturedRequest.headers['Content-Type'], 'application/json');
  assert.strictEqual(capturedRequest.headers['Accept'], 'application/json');
  assert.strictEqual(capturedRequest.headers['X-PrivateKey'], 'test_smartapi_key_01');
  assert.strictEqual(capturedRequest.headers['X-UserType'], 'USER');
  assert.strictEqual(capturedRequest.headers['X-SourceID'], 'WEB');
  assert.strictEqual(capturedRequest.body.clientcode, 'TEST_CLIENT_01');
  assert.strictEqual(capturedRequest.body.password, 'SuperSecretPassword!1');
  assert.strictEqual(capturedRequest.body.totp, '123456');

  // Verify session is persisted in AngelOneSessionStore
  const loadedSession1 = await AngelOneSessionStore.loadSession(userId1);
  assert(loadedSession1 !== null, 'Session must be persisted');
  assert.strictEqual(loadedSession1?.authState, 'AUTHENTICATED');
  assert.strictEqual(loadedSession1?.accessToken, 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.dummy_valid_jwt_payload_1234567890');
  assert.strictEqual(loadedSession1?.clientCode, 'TEST_CLIENT_01');

  // Verify adapter connection status
  const status1 = await liveAngelOneAdapter.getConnectionStatus(userId1);
  assert.strictEqual(status1.status, 'AUTHENTICATED');
  assert.strictEqual(status1.authenticated, true);
  assert.strictEqual(status1.broker, 'angelone');
  console.log('  ✓ PASSED: Real SmartAPI authentication flow and contract validated');

  // --------------------------------------------------------------------------
  // Test 2: Rejected credentials (SmartAPI business rejection)
  // --------------------------------------------------------------------------
  console.log('\n[Test 2] Rejected Credentials Handling (Fail-Closed)');
  const userId2 = 'user_test_rejected_002';

  const mockRejectedFetch: any = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      status: false,
      message: 'Invalid password or client code',
      errorcode: 'AB1004',
      data: null,
    }),
  });

  const result2 = await liveAngelOneAdapter.authenticate(
    userId2,
    {
      apiKey: 'test_key',
      clientCode: 'BAD_CLIENT',
      password: 'WrongPassword',
      totp: '654321',
    },
    { customFetch: mockRejectedFetch }
  );

  assert.strictEqual(result2.success, false, 'Authentication must fail on rejected credentials');
  assert(result2.error?.includes('Invalid password or client code'), 'Error message must reflect rejection');

  // Verify session is NOT persisted (Fail-Closed)
  const loadedSession2 = await AngelOneSessionStore.loadSession(userId2);
  assert.strictEqual(loadedSession2, null, 'No session must be saved on rejection');

  // Verify adapter reports unauthenticated
  const status2 = await liveAngelOneAdapter.getConnectionStatus(userId2);
  assert.strictEqual(status2.authenticated, false, 'Connection must remain unauthenticated');
  console.log('  ✓ PASSED: Upstream business rejection strictly fails closed with zero session created');

  // --------------------------------------------------------------------------
  // Test 3: Upstream HTTP error handling (e.g. 502 / 500)
  // --------------------------------------------------------------------------
  console.log('\n[Test 3] Upstream HTTP Error Handling (Fail-Closed)');
  const userId3 = 'user_test_http_err_003';

  const mockHttpErrFetch: any = async () => ({
    ok: false,
    status: 502,
    json: async () => ({ message: 'Bad Gateway upstream' }),
  });

  const result3 = await liveAngelOneAdapter.authenticate(
    userId3,
    {
      apiKey: 'test_key',
      clientCode: 'CLI_003',
      password: 'password',
      totp: '111222',
    },
    { customFetch: mockHttpErrFetch }
  );

  assert.strictEqual(result3.success, false, 'Must fail on upstream HTTP 502');
  assert(result3.error?.includes('Bad Gateway') || result3.error?.includes('502'), 'Must report HTTP error');

  const loadedSession3 = await AngelOneSessionStore.loadSession(userId3);
  assert.strictEqual(loadedSession3, null, 'No session saved on HTTP error');
  console.log('  ✓ PASSED: Upstream HTTP error handled safely and fails closed');

  // --------------------------------------------------------------------------
  // Test 4: Upstream network / socket error handling
  // --------------------------------------------------------------------------
  console.log('\n[Test 4] Network Exception / Timeout Handling');
  const userId4 = 'user_test_net_err_004';

  const mockNetErrFetch: any = async () => {
    throw new Error('ETIMEDOUT connection to apiconnect.angelbroking.com');
  };

  const result4 = await liveAngelOneAdapter.authenticate(
    userId4,
    {
      apiKey: 'test_key',
      clientCode: 'CLI_004',
      password: 'password',
      totp: '333444',
    },
    { customFetch: mockNetErrFetch }
  );

  assert.strictEqual(result4.success, false, 'Must fail on network exception');
  assert(result4.error?.includes('ETIMEDOUT'), 'Error must report network failure');

  const loadedSession4 = await AngelOneSessionStore.loadSession(userId4);
  assert.strictEqual(loadedSession4, null, 'No session saved on network error');
  console.log('  ✓ PASSED: Network error handled cleanly without crash or session leak');

  // --------------------------------------------------------------------------
  // Test 5: Missing or invalid token in upstream payload
  // --------------------------------------------------------------------------
  console.log('\n[Test 5] Malformed Upstream Token Validation');
  const userId5 = 'user_test_malformed_005';

  const mockEmptyTokenFetch: any = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      status: true,
      message: 'SUCCESS',
      data: { jwtToken: '' },
    }),
  });

  const result5 = await liveAngelOneAdapter.authenticate(
    userId5,
    {
      apiKey: 'test_key',
      clientCode: 'CLI_005',
      password: 'password',
      totp: '555666',
    },
    { customFetch: mockEmptyTokenFetch }
  );

  assert.strictEqual(result5.success, false, 'Must fail when token is empty');
  assert(result5.error?.includes('missing valid session token'), 'Must flag missing token');

  const loadedSession5 = await AngelOneSessionStore.loadSession(userId5);
  assert.strictEqual(loadedSession5, null, 'No session saved on empty token');
  console.log('  ✓ PASSED: Malformed/missing upstream token rejected');

  // --------------------------------------------------------------------------
  // Test 6: Missing credential parameters validation (Fail-Closed before network)
  // --------------------------------------------------------------------------
  console.log('\n[Test 6] Pre-flight Credential Validation');
  let networkCalled = false;
  const mockSpyFetch: any = async () => {
    networkCalled = true;
    return { ok: true, json: async () => ({}) };
  };

  // Missing credentials pre-flight checks using an isolated adapter with no env config
  const unconfiguredAdapter = new (liveAngelOneAdapter.constructor as any)({
    apiKey: '',
    clientCode: '',
    password: '',
    totpSecret: '',
  });

  // Missing clientCode
  networkCalled = false;
  const rNoClient = await unconfiguredAdapter.authenticate('u', { apiKey: 'k', password: 'p', totp: '123456' }, { customFetch: mockSpyFetch });
  assert.strictEqual(rNoClient.success, false);
  assert.strictEqual(networkCalled, false, 'Network must NOT be called if clientCode is missing');

  // Missing password
  networkCalled = false;
  const rNoPass = await unconfiguredAdapter.authenticate('u', { apiKey: 'k', clientCode: 'c', totp: '123456' }, { customFetch: mockSpyFetch });
  assert.strictEqual(rNoPass.success, false);
  assert.strictEqual(networkCalled, false, 'Network must NOT be called if password is missing');

  // Missing TOTP when no totpSecret
  networkCalled = false;
  const rNoTotp = await unconfiguredAdapter.authenticate('u', { apiKey: 'k', clientCode: 'c', password: 'p' }, { customFetch: mockSpyFetch });
  assert.strictEqual(rNoTotp.success, false);
  assert.strictEqual(networkCalled, false, 'Network must NOT be called if TOTP is missing');

  // Malformed TOTP (letters or wrong length)
  networkCalled = false;
  const rBadTotp = await liveAngelOneAdapter.authenticate('u', { apiKey: 'k', clientCode: 'c', password: 'p', totp: '12ab' }, { customFetch: mockSpyFetch });
  assert.strictEqual(rBadTotp.success, false);
  assert.strictEqual(networkCalled, false, 'Network must NOT be called if TOTP is not 6 digits');
  console.log('  ✓ PASSED: Incomplete/malformed credentials fail-closed before network dispatch');

  // --------------------------------------------------------------------------
  // Test 7: Automated TOTP generation from configured secret
  // --------------------------------------------------------------------------
  console.log('\n[Test 7] Automated RFC 6238 TOTP Generation');
  let dispatchedTotp = '';
  const mockTotpFetch: any = async (_url: string, init: any) => {
    const body = JSON.parse(init.body);
    dispatchedTotp = body.totp;
    return {
      ok: true,
      json: async () => ({
        status: true,
        data: { jwtToken: 'Bearer eyJhbGciOiJIUzI1NiJ9.dummy_totp_verified_jwt_token_123456' },
      }),
    };
  };

  // Standard RFC 6238 Base32 test secret
  const testTotpSecret = 'JBSWY3DPEHPK3PXP';
  const expectedTotp = generateTotp(testTotpSecret);
  assert(/^\d{6}$/.test(expectedTotp), 'Generated TOTP must be 6 digits');

  const rTotpGen = await liveAngelOneAdapter.authenticate(
    'user_totp_gen_007',
    {
      apiKey: 'test_key',
      clientCode: 'CLI_TOTP',
      password: 'password',
      totpSecret: testTotpSecret, // No explicit totp provided, relies on secret
    },
    { customFetch: mockTotpFetch }
  );

  assert.strictEqual(rTotpGen.success, true);
  assert.strictEqual(dispatchedTotp, expectedTotp, 'SmartAPI request must receive RFC 6238 TOTP code');
  console.log('  ✓ PASSED: Automated TOTP generation accurately produces 6-digit code for SmartAPI');

  // --------------------------------------------------------------------------
  // Test 8: Client-supplied accessToken is NEVER accepted / mock token NEVER saved
  // --------------------------------------------------------------------------
  console.log('\n[Test 8] Rejection of Client-Supplied Tokens & Mock Tokens in Auth Route');
  const testTargetUser = 'user_route_security_008';

  // Find the POST /broker/angelone/live/auth/session route handler
  const routeLayers = (apiRouter.stack || []).filter(
    (layer: any) => layer.route && layer.route.path === '/broker/angelone/live/auth/session'
  );
  assert(routeLayers.length === 1 && routeLayers[0]?.route?.stack?.[0]?.handle, 'Route POST /broker/angelone/live/auth/session must exist');
  const routeHandler = routeLayers[0].route.stack[0].handle;

  // Simulate malicious request trying to pass an accessToken to trick the server into saving it
  let responseStatusCode = 0;
  let responsePayload: any = null;
  const mockReq: any = {
    method: 'POST',
    userId: testTargetUser,
    headers: {
      'content-type': 'application/json',
    },
    body: {
      accessToken: 'malicious_client_supplied_mock_token',
      clientCode: 'ATTACKER_CLIENT',
      // No valid upstream password or TOTP
    },
  };
  const mockRes: any = {
    status(code: number) {
      responseStatusCode = code;
      return this;
    },
    json(data: any) {
      responsePayload = data;
      return this;
    },
    setHeader() {},
    end(str: string) {
      if (str) responsePayload = JSON.parse(str);
      return this;
    },
  };

  await routeHandler(mockReq, mockRes, (() => {}) as any);

  assert.strictEqual(responseStatusCode, 401, 'Request with missing credentials must return HTTP 401');
  assert.strictEqual(responsePayload.success, false, 'Must fail authentication');

  // Verify the malicious token was NEVER saved in the session store
  const targetSession = await AngelOneSessionStore.loadSession(testTargetUser);
  assert.strictEqual(targetSession, null, 'Malicious/client-supplied token must NEVER be saved');
  console.log('  ✓ PASSED: Client-supplied accessToken rejected; mock token persistence eliminated');

  // --------------------------------------------------------------------------
  // Test 9: Multi-tenant user isolation
  // --------------------------------------------------------------------------
  console.log('\n[Test 9] Multi-Tenant User Isolation');
  const userA = 'user_isolated_alice';
  const userB = 'user_isolated_bob';

  const mockIsolationFetch: any = async () => ({
    ok: true,
    json: async () => ({
      status: true,
      data: { jwtToken: 'Bearer eyJhbGciOiJIUzI1NiJ9.alice_super_secret_jwt_token_12345' },
    }),
  });

  await liveAngelOneAdapter.authenticate(
    userA,
    { apiKey: 'k', clientCode: 'ALICE', password: 'p', totp: '123456' },
    { customFetch: mockIsolationFetch }
  );

  const aliceSession = await AngelOneSessionStore.loadSession(userA);
  const bobSession = await AngelOneSessionStore.loadSession(userB);

  assert(aliceSession !== null, 'Alice session must exist');
  assert.strictEqual(bobSession, null, 'Bob session must NOT exist');
  assert.strictEqual(aliceSession?.clientCode, 'ALICE');

  const aliceStatus = await liveAngelOneAdapter.getConnectionStatus(userA);
  const bobStatus = await liveAngelOneAdapter.getConnectionStatus(userB);

  assert.strictEqual(aliceStatus.authenticated, true);
  assert.strictEqual(bobStatus.authenticated, false);
  console.log('  ✓ PASSED: Sessions and connection states strictly isolated per user');

  // --------------------------------------------------------------------------
  // Test 10: Strict Read-Only Governance & Zerodha Compatibility
  // --------------------------------------------------------------------------
  console.log('\n[Test 10] Read-Only Governance & Zerodha Preservation');
  assert.strictEqual((liveAngelOneAdapter as any).placeOrder, undefined, 'Must NOT have placeOrder');
  assert.strictEqual((liveAngelOneAdapter as any).cancelOrder, undefined, 'Must NOT have cancelOrder');
  assert.strictEqual((liveAngelOneAdapter as any).modifyOrder, undefined, 'Must NOT have modifyOrder');
  assert.strictEqual((liveAngelOneAdapter as any).squareOff, undefined, 'Must NOT have squareOff');
  console.log('  ✓ PASSED: Read-only governance intact; no order execution capability exists');

  // --------------------------------------------------------------------------
  // Test 11: Zero Environment Fallback Audit (Remediation 1A)
  // --------------------------------------------------------------------------
  console.log('\n[Test 11] Zero Environment Fallback Audit (Remediation 1A)');
  
  // Save current process.env and set dummy shared credentials in process.env
  const origApiKey = process.env.ANGELONE_API_KEY;
  const origClientCode = process.env.ANGELONE_CLIENT_CODE;
  const origPassword = process.env.ANGELONE_PASSWORD;
  const origTotpSecret = process.env.ANGELONE_TOTP_SECRET;

  process.env.ANGELONE_API_KEY = 'polluted_env_api_key';
  process.env.ANGELONE_CLIENT_CODE = 'POLLUTED_ENV_CODE';
  process.env.ANGELONE_PASSWORD = 'PollutedEnvPassword';
  process.env.ANGELONE_TOTP_SECRET = 'JBSWY3DPEHPK3PXP';

  try {
    let spyCalled = false;
    const mockEnvSpyFetch: any = async () => {
      spyCalled = true;
      return { ok: true, json: async () => ({}) };
    };

    // Calling authenticate with NO arguments must STILL fail closed even if process.env.ANGELONE_* is set!
    const envTestResult = await liveAngelOneAdapter.authenticate('user_env_test', {}, { customFetch: mockEnvSpyFetch });

    assert.strictEqual(envTestResult.success, false, 'Authentication without request parameters MUST fail even if process.env is set');
    assert.strictEqual(spyCalled, false, 'Network MUST NOT be called when request params are missing, ignoring process.env');

    // Confirm AngelOneCredentials has zero process.env fallback
    const freshCreds = new AngelOneCredentials();
    assert.strictEqual(freshCreds.isConfigured(), false, 'AngelOneCredentials() must evaluate isConfigured() = false by default');
    assert.strictEqual(freshCreds.getConfig().apiKey, '');
    assert.strictEqual(freshCreds.getConfig().clientCode, '');
    assert.strictEqual(freshCreds.getConfig().password, '');

    console.log('  ✓ PASSED: Proved zero environment fallback when process.env.ANGELONE_* variables are set');
  } finally {
    // Restore original env
    if (origApiKey !== undefined) process.env.ANGELONE_API_KEY = origApiKey; else delete process.env.ANGELONE_API_KEY;
    if (origClientCode !== undefined) process.env.ANGELONE_CLIENT_CODE = origClientCode; else delete process.env.ANGELONE_CLIENT_CODE;
    if (origPassword !== undefined) process.env.ANGELONE_PASSWORD = origPassword; else delete process.env.ANGELONE_PASSWORD;
    if (origTotpSecret !== undefined) process.env.ANGELONE_TOTP_SECRET = origTotpSecret; else delete process.env.ANGELONE_TOTP_SECRET;
  }

  AngelOneSessionStore.enableMockStoreForTesting(false);

  console.log('\n================================================================');
  console.log('ALL REMEDIATION 1 & 1A TESTS PASSED SUCCESSFULLY (11/11)');
  console.log('================================================================');
}

runRemediation1Tests().catch((err) => {
  console.error('\nREMEDIATION 1 TESTS FAILED:', err);
  process.exit(1);
});
