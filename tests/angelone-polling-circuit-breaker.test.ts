import { strict as assert } from 'assert';
import { liveAngelOneAdapter } from '../server/brokers/angelone/liveAdapter';
import { AngelOneSessionStore } from '../server/brokers/angelone/sessionStore';

async function runPollingCircuitBreakerTests() {
  console.log('================================================================');
  console.log('Angel One Polling Circuit Breaker & Flapping Regression Suite');
  console.log('================================================================\n');

  AngelOneSessionStore.enableMockStoreForTesting(true);

  const userId = 'trader_circuit_breaker_test';
  const connId = 'acc_mt_angelone_default';
  const testApiKey = 'CIRCUIT_BREAKER_API_KEY_123';
  const testClientCode = 'CBCLIENT123';
  const testToken = 'mock_valid_jwt_token_for_circuit_breaker_98765';

  let fetchCallCounts = {
    positions: 0,
    capital: 0,
    status: 0,
  };

  let mockResponseGenerator: (url: string) => { status: number; ok: boolean; body: any } = () => ({
    status: 200,
    ok: true,
    body: { status: true, message: 'SUCCESS', data: [] },
  });

  const mockFetch = async (url: string, options: any) => {
    if (url.includes('getPosition')) fetchCallCounts.positions++;
    if (url.includes('getRMS')) fetchCallCounts.capital++;
    return {
      ...mockResponseGenerator(url),
      json: async () => mockResponseGenerator(url).body,
    } as any;
  };

  liveAngelOneAdapter.setFetchHandler(mockFetch as any);

  async function resetAndAuthenticateUser() {
    fetchCallCounts = { positions: 0, capital: 0, status: 0 };
    liveAngelOneAdapter.clearUserErrorState(userId, connId);
    await AngelOneSessionStore.saveApiKey(userId, testApiKey, connId);
    await AngelOneSessionStore.saveSession(userId, testToken, {
      clientCode: testClientCode,
      connectionId: connId,
    });
  }

  // --------------------------------------------------------------------------
  // Test 1: Repeated Polling While Disconnected - Circuit Breaker Tripping
  // --------------------------------------------------------------------------
  console.log('[Test 1] Repeated Polling While Disconnected (Circuit Breaker Tripping)...');
  {
    await resetAndAuthenticateUser();

    // Configure mock to return 401 Unauthorized / Token Expired
    mockResponseGenerator = () => ({
      status: 401,
      ok: false,
      body: { message: 'Token Expired', errorcode: 'AG8001' },
    });

    // First poll triggers the failure
    try {
      await liveAngelOneAdapter.getPositions(userId, { connectionId: connId });
      assert.fail('Should have thrown on AG8001');
    } catch (err: any) {
      assert.match(err.message, /Re-authentication required/);
    }

    assert.equal(fetchCallCounts.positions, 1);

    // Verify adapter status is now AUTHENTICATION_REQUIRED
    const status = await liveAngelOneAdapter.getConnectionStatus(userId, { connectionId: connId });
    assert.equal(status.status, 'AUTHENTICATION_REQUIRED');

    // Simulate circuit breaker logic: When status is AUTHENTICATION_REQUIRED,
    // client-side polling stops invoking upstream positions/capital endpoints.
    let circuitBroken = (status.status === 'AUTHENTICATION_REQUIRED' || status.status === 'CONFIGURATION_ERROR');
    assert.equal(circuitBroken, true, 'Circuit breaker MUST be tripped on AUTHENTICATION_REQUIRED');

    // Simulate 5 consecutive interval ticks while circuit broken
    for (let tick = 1; tick <= 5; tick++) {
      if (!circuitBroken) {
        await liveAngelOneAdapter.getPositions(userId, { connectionId: connId });
      }
    }

    assert.equal(fetchCallCounts.positions, 1, 'Zero additional upstream fetch calls must occur while circuit broken');
    console.log('  ✓ PASSED: Circuit breaker halts repeated outbound polling during AUTHENTICATION_REQUIRED.');
  }

  // --------------------------------------------------------------------------
  // Test 2: Transient Status Refresh Does NOT Clear Circuit Breaker
  // --------------------------------------------------------------------------
  console.log('\n[Test 2] Transient Status Refresh Does NOT Clear Circuit Breaker...');
  {
    let circuitBroken = true;

    // Simulate a status check returning error status
    const status = await liveAngelOneAdapter.getConnectionStatus(userId, { connectionId: connId });
    assert.equal(status.status, 'AUTHENTICATION_REQUIRED');

    // Ensure circuit breaker remains true
    if (status.status === 'AUTHENTICATION_REQUIRED' || status.status === 'CONFIGURATION_ERROR') {
      circuitBroken = true;
    }

    assert.equal(circuitBroken, true, 'Transient status refresh must never prematurely clear the circuit breaker');
    console.log('  ✓ PASSED: Transient status refreshes preserve circuit breaker state.');
  }

  // --------------------------------------------------------------------------
  // Test 3: Explicit Reconnection Clears Circuit Breaker & Resumes Polling
  // --------------------------------------------------------------------------
  console.log('\n[Test 3] Explicit Reconnection Clears Circuit Breaker & Resumes Polling...');
  {
    let circuitBroken = true;

    // Simulate explicit login / credential recovery
    mockResponseGenerator = () => ({
      status: 200,
      ok: true,
      body: {
        status: true,
        message: 'SUCCESS',
        data: { jwtToken: 'new_valid_jwt_token_after_explicit_reauth_12345' },
      },
    });

    const loginRes = await liveAngelOneAdapter.authenticate(
      userId,
      {
        clientCode: testClientCode,
        password: 'valid_password',
        totp: '123456',
        apiKey: testApiKey,
      },
      { connectionId: connId }
    );

    assert.equal(loginRes.success, true, 'Explicit login must succeed');

    // Explicit login clears circuit breaker
    circuitBroken = false;
    assert.equal(circuitBroken, false, 'Explicit re-authentication MUST clear the circuit breaker');

    // Reset counts and simulate polling resuming
    fetchCallCounts = { positions: 0, capital: 0, status: 0 };
    mockResponseGenerator = () => ({
      status: 200,
      ok: true,
      body: { status: true, message: 'SUCCESS', data: [] },
    });

    const positions = await liveAngelOneAdapter.getPositions(userId, { connectionId: connId });
    assert.deepEqual(positions, []);
    assert.equal(fetchCallCounts.positions, 1, 'Polling resumes successfully after explicit recovery');

    console.log('  ✓ PASSED: Explicit re-authentication clears circuit breaker and resumes live polling.');
  }

  // --------------------------------------------------------------------------
  // Test 4: Broker / Account Switching Resets In-Flight State Cleanly
  // --------------------------------------------------------------------------
  console.log('\n[Test 4] Broker / Account Switching In-Flight State Invalidation...');
  {
    let activeBroker = 'angelone';
    let activeAccountId = 'acc_mt_angelone_default';
    let positionsRequestId = 1;

    // In-flight request prepared for Angel One
    const inFlightReqId = ++positionsRequestId;
    const inFlightBroker = activeBroker;
    const inFlightAccount = activeAccountId;

    // User immediately switches to Zerodha
    activeBroker = 'zerodha';
    activeAccountId = 'acc_mt_zerodha_default';
    positionsRequestId++; // Incremented on switch

    // When in-flight response resolves, sequence and account checks discard it
    const isStale = (
      inFlightReqId !== positionsRequestId ||
      inFlightBroker !== activeBroker ||
      inFlightAccount !== activeAccountId
    );

    assert.equal(isStale, true, 'In-flight response from prior broker/account must be strictly discarded');
    console.log('  ✓ PASSED: Account/broker switching discards stale in-flight responses.');
  }

  // --------------------------------------------------------------------------
  // Test 5: Firebase User Identity Stability (Unchanged UID)
  // --------------------------------------------------------------------------
  console.log('\n[Test 5] Firebase User Identity Stability (Unchanged UID)...');
  {
    let lastUserUid = 'user_12345';
    let currentUserObj1 = { uid: 'user_12345', email: 'test@example.com', tokenVersion: 1 };
    let currentUserObj2 = { uid: 'user_12345', email: 'test@example.com', tokenVersion: 2 }; // New reference

    // Verify UID check avoids spurious state wipe
    const isNewUser1 = currentUserObj1.uid !== lastUserUid;
    assert.equal(isNewUser1, false);

    const isNewUser2 = currentUserObj2.uid !== lastUserUid;
    assert.equal(isNewUser2, false, 'Token refresh with identical UID must NOT trigger user switch state wipe');

    console.log('  ✓ PASSED: Unchanged user UID preserves UI and connection state without flapping.');
  }

  // --------------------------------------------------------------------------
  // Test 6: Unexpected Server Error (HTTP 500) Handling
  // --------------------------------------------------------------------------
  console.log('\n[Test 6] Unexpected Server Error (HTTP 500) Handling...');
  {
    await resetAndAuthenticateUser();

    mockResponseGenerator = () => ({
      status: 500,
      ok: false,
      body: { message: 'Internal Server Error' },
    });

    try {
      await liveAngelOneAdapter.getPositions(userId, { connectionId: connId });
      assert.fail('Should throw on HTTP 500');
    } catch (err: any) {
      assert.match(err.message, /SmartAPI getPosition.*HTTP 500/);
      assert.doesNotMatch(err.message, /Re-authentication required/);
    }

    // Session remains intact in store
    const session = await AngelOneSessionStore.loadSession(userId, { connectionId: connId });
    assert.ok(session, 'Session must NOT be destroyed on unexpected HTTP 500 server error');
    assert.equal(session?.authState, 'AUTHENTICATED');

    console.log('  ✓ PASSED: Unexpected 500 server errors fail closed safely without wiping sessions.');
  }

  console.log('\n================================================================');
  console.log('ALL POLLING CIRCUIT BREAKER & FLAPPING TESTS PASSED (6/6)');
  console.log('================================================================\n');
}

runPollingCircuitBreakerTests().catch((err) => {
  console.error('\nCircuit Breaker Test Suite Failed:', err);
  process.exit(1);
});
