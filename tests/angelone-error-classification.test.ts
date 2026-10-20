import { strict as assert } from 'assert';
import { liveAngelOneAdapter } from '../server/brokers/angelone/liveAdapter';
import { AngelOneSessionStore } from '../server/brokers/angelone/sessionStore';

async function runErrorClassificationTests() {
  console.log('================================================================');
  console.log('Angel One Explicit Error Classification Test Suite');
  console.log('================================================================\n');

  AngelOneSessionStore.enableMockStoreForTesting(true);

  const userId = 'trader_error_class_test';
  const connId = 'acc_mt_angelone_default';
  const testApiKey = 'VALID_API_KEY_999';
  const testClientCode = 'A999999';
  const testToken = 'mock_valid_jwt_token_for_error_classification_tests_12345';

  let currentFetchResponse: { status: number; ok: boolean; body: any } | null = null;

  const mockFetch = async () => {
    if (!currentFetchResponse) {
      throw new Error('No mock response configured');
    }
    return {
      ok: currentFetchResponse.ok,
      status: currentFetchResponse.status,
      json: async () => currentFetchResponse!.body,
    } as any;
  };

  liveAngelOneAdapter.setFetchHandler(mockFetch as any);

  async function resetAndAuthenticateUser() {
    liveAngelOneAdapter.clearUserErrorState(userId, connId);
    await AngelOneSessionStore.saveApiKey(userId, testApiKey, connId);
    await AngelOneSessionStore.saveSession(userId, testToken, {
      clientCode: testClientCode,
      connectionId: connId,
    });
  }

  // --------------------------------------------------------------------------
  // Test 1: HTTP 403 with Empty Error Code / Generic 'HTTP 403'
  // --------------------------------------------------------------------------
  console.log('[Test 1] HTTP 403 with Empty Error Code (getPosition & getRMS)...');
  {
    await resetAndAuthenticateUser();

    currentFetchResponse = {
      status: 403,
      ok: false,
      body: { message: 'HTTP 403', errorcode: '' },
    };

    // getPositions should throw generic error, NOT invalidate session
    try {
      await liveAngelOneAdapter.getPositions(userId, { connectionId: connId });
      assert.fail('getPosition should have thrown on HTTP 403');
    } catch (err: any) {
      assert.match(err.message, /SmartAPI getPosition.*HTTP 403/);
      assert.doesNotMatch(err.message, /Re-authentication required/);
      assert.doesNotMatch(err.message, /Invalid API key/);
    }

    // Verify session remains stored and valid
    let loadedSession = await AngelOneSessionStore.loadSession(userId, { connectionId: connId });
    assert.ok(loadedSession, 'Session MUST remain intact after generic HTTP 403');
    assert.equal(loadedSession?.authState, 'AUTHENTICATED');

    let status = await liveAngelOneAdapter.getConnectionStatus(userId, { connectionId: connId });
    assert.equal(status.status, 'AUTHENTICATED', 'Status must stay AUTHENTICATED on generic HTTP 403');

    // getRMS should return connectionStatus 'ERROR', NOT invalidate session or mark auth required
    const capital = await liveAngelOneAdapter.getCapital(userId, { connectionId: connId });
    assert.equal(capital.connectionStatus, 'ERROR', 'getRMS must return connectionStatus ERROR for generic HTTP 403');
    assert.match(capital.semanticNote || '', /SmartAPI getRMS.*HTTP 403/);
    assert.doesNotMatch(capital.semanticNote || '', /Re-authentication required/);

    loadedSession = await AngelOneSessionStore.loadSession(userId, { connectionId: connId });
    assert.ok(loadedSession, 'Session MUST remain intact after getRMS generic HTTP 403');

    status = await liveAngelOneAdapter.getConnectionStatus(userId, { connectionId: connId });
    assert.equal(status.status, 'AUTHENTICATED', 'Status must stay AUTHENTICATED after getRMS generic HTTP 403');

    console.log('  ✓ PASSED: Generic HTTP 403 fails closed without invalidating session or mislabeling auth');
  }

  // --------------------------------------------------------------------------
  // Test 2: AB1010 API-Key Mismatch Error on both getPosition and getRMS
  // --------------------------------------------------------------------------
  console.log('\n[Test 2] AB1010 API Key Error on getPosition & getRMS...');
  {
    await resetAndAuthenticateUser();

    // AB1010 on getPosition
    currentFetchResponse = {
      status: 403,
      ok: false,
      body: { message: 'Invalid Access Token/API Key', errorcode: 'AB1010' },
    };

    try {
      await liveAngelOneAdapter.getPositions(userId, { connectionId: connId });
      assert.fail('getPosition should have thrown on AB1010');
    } catch (err: any) {
      assert.match(err.message, /Invalid API key configuration/);
      assert.doesNotMatch(err.message, /Re-authentication required/);
    }

    // Verify stored JWT session is NOT deleted/invalidated
    let loadedSession = await AngelOneSessionStore.loadSession(userId, { connectionId: connId });
    assert.ok(loadedSession, 'JWT Session must NOT be wiped on API key error AB1010');

    // Verify getConnectionStatus reports CONFIGURATION_ERROR
    let status = await liveAngelOneAdapter.getConnectionStatus(userId, { connectionId: connId });
    assert.equal(status.status, 'CONFIGURATION_ERROR', 'AB1010 must transition connection status to CONFIGURATION_ERROR');

    // Reset error state and test AB1010 on getRMS
    await resetAndAuthenticateUser();

    currentFetchResponse = {
      status: 403,
      ok: false,
      body: { message: 'Invalid Access Token/API Key', errorcode: 'AB1010' },
    };

    const capital = await liveAngelOneAdapter.getCapital(userId, { connectionId: connId });
    assert.equal(capital.connectionStatus, 'CONFIGURATION_ERROR', 'getRMS must return CONFIGURATION_ERROR for AB1010');
    assert.match(capital.semanticNote || '', /Invalid API key configuration/);

    loadedSession = await AngelOneSessionStore.loadSession(userId, { connectionId: connId });
    assert.ok(loadedSession, 'JWT Session must NOT be wiped on getRMS AB1010');

    status = await liveAngelOneAdapter.getConnectionStatus(userId, { connectionId: connId });
    assert.equal(status.status, 'CONFIGURATION_ERROR', 'getRMS AB1010 must transition status to CONFIGURATION_ERROR');

    console.log('  ✓ PASSED: AB1010 reports CONFIGURATION_ERROR without invalidating valid JWT session');
  }

  // --------------------------------------------------------------------------
  // Test 3: Confirmed Expired Token Errors (AG8002 / HTTP 401)
  // --------------------------------------------------------------------------
  console.log('\n[Test 3] Confirmed Expired Token Errors (AG8002 & 401)...');
  {
    await resetAndAuthenticateUser();

    // AG8002 session expired
    currentFetchResponse = {
      status: 403,
      ok: false,
      body: { message: 'Session Expired or Unauthorized', errorcode: 'AG8002' },
    };

    try {
      await liveAngelOneAdapter.getPositions(userId, { connectionId: connId });
      assert.fail('getPosition should have thrown on AG8002');
    } catch (err: any) {
      assert.match(err.message, /Re-authentication required/);
    }

    // Session must be invalidated (cleared or marked AUTHENTICATION_REQUIRED/isExpired)
    let loadedSession = await AngelOneSessionStore.loadSession(userId, { connectionId: connId });
    assert.ok(!loadedSession || loadedSession.authState === 'AUTHENTICATION_REQUIRED' || loadedSession.isExpired === true, 'Session must be invalidated on AG8002');

    let status = await liveAngelOneAdapter.getConnectionStatus(userId, { connectionId: connId });
    assert.equal(status.status, 'AUTHENTICATION_REQUIRED', 'Status must transition to AUTHENTICATION_REQUIRED on AG8002');

    // Test HTTP 401 on getRMS
    await resetAndAuthenticateUser();

    currentFetchResponse = {
      status: 401,
      ok: false,
      body: { message: 'Unauthorized', errorcode: 'AG8001' },
    };

    const capital = await liveAngelOneAdapter.getCapital(userId, { connectionId: connId });
    assert.equal(capital.connectionStatus, 'AUTHENTICATION_REQUIRED', 'getRMS must return AUTHENTICATION_REQUIRED on HTTP 401');

    loadedSession = await AngelOneSessionStore.loadSession(userId, { connectionId: connId });
    assert.ok(!loadedSession || loadedSession.authState === 'AUTHENTICATION_REQUIRED' || loadedSession.isExpired === true, 'Session must be invalidated on HTTP 401');

    status = await liveAngelOneAdapter.getConnectionStatus(userId, { connectionId: connId });
    assert.equal(status.status, 'AUTHENTICATION_REQUIRED', 'Status must transition to AUTHENTICATION_REQUIRED on HTTP 401');

    console.log('  ✓ PASSED: Confirmed token errors invalidate session and transition status to AUTHENTICATION_REQUIRED');
  }

  // --------------------------------------------------------------------------
  // Test 4: Unrelated 403 Responses (e.g. WAF Block / Rate Limit)
  // --------------------------------------------------------------------------
  console.log('\n[Test 4] Unrelated 403 Responses (WAF / Rate Limit)...');
  {
    await resetAndAuthenticateUser();

    currentFetchResponse = {
      status: 403,
      ok: false,
      body: { message: 'Access Denied by WAF', errorcode: 'WAF_BLOCK' },
    };

    try {
      await liveAngelOneAdapter.getPositions(userId, { connectionId: connId });
      assert.fail('getPosition should throw on WAF block');
    } catch (err: any) {
      assert.match(err.message, /SmartAPI getPosition \[WAF_BLOCK\] \(HTTP 403\): Access Denied by WAF/);
      assert.doesNotMatch(err.message, /Re-authentication required/);
      assert.doesNotMatch(err.message, /Invalid API key/);
    }

    let loadedSession = await AngelOneSessionStore.loadSession(userId, { connectionId: connId });
    assert.ok(loadedSession, 'Session MUST remain intact on WAF block 403');

    let status = await liveAngelOneAdapter.getConnectionStatus(userId, { connectionId: connId });
    assert.equal(status.status, 'AUTHENTICATED', 'Status must remain AUTHENTICATED on WAF block 403');

    // Test Rate Limit on getRMS
    currentFetchResponse = {
      status: 403,
      ok: false,
      body: { message: 'Too many requests', errorcode: 'LIMIT_EXCEEDED' },
    };

    const capital = await liveAngelOneAdapter.getCapital(userId, { connectionId: connId });
    assert.equal(capital.connectionStatus, 'ERROR', 'getRMS must return connectionStatus ERROR on Rate Limit 403');
    assert.match(capital.semanticNote || '', /SmartAPI getRMS \[LIMIT_EXCEEDED\] \(HTTP 403\): Too many requests/);

    loadedSession = await AngelOneSessionStore.loadSession(userId, { connectionId: connId });
    assert.ok(loadedSession, 'Session MUST remain intact on Rate Limit 403');

    status = await liveAngelOneAdapter.getConnectionStatus(userId, { connectionId: connId });
    assert.equal(status.status, 'AUTHENTICATED', 'Status must remain AUTHENTICATED on Rate Limit 403');

    console.log('  ✓ PASSED: Unrelated 403 responses preserve session and do not misclassify error state');
  }

  console.log('\n================================================================');
  console.log('ALL EXPLICIT ERROR CLASSIFICATION TESTS PASSED SUCCESSFULLY (4/4)');
  console.log('================================================================\n');
}

runErrorClassificationTests().catch((err) => {
  console.error('Test Suite Failed:', err);
  process.exit(1);
});
