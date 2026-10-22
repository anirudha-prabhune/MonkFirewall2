import { strict as assert } from 'assert';
import { liveAngelOneAdapter } from '../server/brokers/angelone/liveAdapter';
import { AngelOneSessionStore } from '../server/brokers/angelone/sessionStore';

async function runStage2PositionsRmsTests() {
  console.log('================================================================');
  console.log('Angel One Stage 2: Positions & RMS Comprehensive Test Suite');
  console.log('================================================================\n');

  AngelOneSessionStore.enableMockStoreForTesting(true);

  const userId = 'trader_stage2_test_user';
  const connId = 'acc_mt_angelone_default';
  const testApiKey = 'STAGE2_API_KEY_VALID_999';
  const testClientCode = 'S2CLIENT999';
  const testToken = 'mock_valid_jwt_token_for_stage2_tests_1234567890';

  let currentFetchResponse: { status: number; ok: boolean; body: any } | null = null;
  let shouldSimulateNetworkError = false;

  const mockFetch = async (url: string, options: any) => {
    if (shouldSimulateNetworkError) {
      throw new Error('Network timeout / connection reset');
    }
    if (!currentFetchResponse) {
      throw new Error('No mock response configured');
    }

    // Header inspection assertion
    assert.equal(options.headers['X-PrivateKey'], testApiKey, 'Outbound request MUST include user stored X-PrivateKey');
    assert.ok(options.headers['Authorization'].includes(testToken), 'Outbound request MUST include Bearer JWT');
    assert.equal(options.headers['X-UserType'], 'USER');
    assert.equal(options.headers['X-SourceID'], 'WEB');

    return {
      ok: currentFetchResponse.ok,
      status: currentFetchResponse.status,
      json: async () => currentFetchResponse!.body,
    } as any;
  };

  liveAngelOneAdapter.setFetchHandler(mockFetch as any);

  async function resetAndAuthenticateUser() {
    shouldSimulateNetworkError = false;
    liveAngelOneAdapter.clearUserErrorState(userId, connId);
    await AngelOneSessionStore.saveApiKey(userId, testApiKey, connId);
    await AngelOneSessionStore.saveSession(userId, testToken, {
      clientCode: testClientCode,
      connectionId: connId,
    });
  }

  // --------------------------------------------------------------------------
  // Scenario 1: Successful Responses (getPositions & getRMS)
  // --------------------------------------------------------------------------
  console.log('[Scenario 1] Successful Responses (getPositions & getRMS)...');
  {
    await resetAndAuthenticateUser();

    currentFetchResponse = {
      status: 200,
      ok: true,
      body: {
        status: true,
        message: 'SUCCESS',
        errorcode: '',
        data: [
          {
            exchange: 'NSE',
            tradingsymbol: 'RELIANCE-EQ',
            symboltoken: '2885',
            producttype: 'INTRADAY',
            netqty: '10',
            avgprice: '2450.50',
            ltp: '2480.00',
            pnl: '295.00',
          },
        ],
      },
    };

    const positions = await liveAngelOneAdapter.getPositions(userId, { connectionId: connId });
    assert.equal(positions.length, 1);
    assert.equal(positions[0].tradingsymbol, 'RELIANCE-EQ');
    assert.equal(positions[0].quantity, 10);
    assert.equal(positions[0].pnl, 295);

    currentFetchResponse = {
      status: 200,
      ok: true,
      body: {
        status: true,
        message: 'SUCCESS',
        errorcode: '',
        data: {
          net: '500000.00',
          availablecash: '450000.00',
          availablelimitmargin: '450000.00',
          utilisedDebits: '50000.00',
          withdrawablebalance: '400000.00',
        },
      },
    };

    const capital = await liveAngelOneAdapter.getCapital(userId, { connectionId: connId });
    assert.equal(capital.connectionStatus, 'AUTHENTICATED');
    assert.equal(capital.isStale, false);
    assert.equal(capital.netBalance, 500000);
    assert.equal(capital.availableCash, 450000);

    const connStatus = await liveAngelOneAdapter.getConnectionStatus(userId, { connectionId: connId });
    assert.equal(connStatus.status, 'AUTHENTICATED');

    console.log('  ✓ PASSED: Success scenario parses live positions and RMS capital accurately.');
  }

  // --------------------------------------------------------------------------
  // Scenario 2: API Key Error AB1010
  // --------------------------------------------------------------------------
  console.log('\n[Scenario 2] API Key Error AB1010 (getPositions & getRMS)...');
  {
    await resetAndAuthenticateUser();

    currentFetchResponse = {
      status: 403,
      ok: false,
      body: { message: 'Invalid Private API Key', errorcode: 'AB1010' },
    };

    try {
      await liveAngelOneAdapter.getPositions(userId, { connectionId: connId });
      assert.fail('getPositions should throw on AB1010');
    } catch (err: any) {
      assert.match(err.message, /Invalid API key configuration/);
    }

    let connStatus = await liveAngelOneAdapter.getConnectionStatus(userId, { connectionId: connId });
    assert.equal(connStatus.status, 'CONFIGURATION_ERROR');

    // Stored session MUST NOT be wiped
    let session = await AngelOneSessionStore.loadSession(userId, { connectionId: connId });
    assert.ok(session, 'JWT session MUST remain in store on AB1010');

    // getRMS under AB1010 returns CONFIGURATION_ERROR
    const capital = await liveAngelOneAdapter.getCapital(userId, { connectionId: connId });
    assert.equal(capital.connectionStatus, 'CONFIGURATION_ERROR');
    assert.equal(capital.isStale, true);
    assert.equal(capital.netBalance, null);

    console.log('  ✓ PASSED: AB1010 sets CONFIGURATION_ERROR without invalidating valid JWT session.');
  }

  // --------------------------------------------------------------------------
  // Scenario 3: Confirmed Expired Token (401 / AG8002)
  // --------------------------------------------------------------------------
  console.log('\n[Scenario 3] Confirmed Token Expiry (AG8002 & 401)...');
  {
    await resetAndAuthenticateUser();

    currentFetchResponse = {
      status: 403,
      ok: false,
      body: { message: 'Session Expired or Token Invalid', errorcode: 'AG8002' },
    };

    try {
      await liveAngelOneAdapter.getPositions(userId, { connectionId: connId });
      assert.fail('getPositions should throw on AG8002');
    } catch (err: any) {
      assert.match(err.message, /Re-authentication required/);
    }

    let connStatus = await liveAngelOneAdapter.getConnectionStatus(userId, { connectionId: connId });
    assert.equal(connStatus.status, 'AUTHENTICATION_REQUIRED');

    // Stored session MUST be invalidated
    let session = await AngelOneSessionStore.loadSession(userId, { connectionId: connId });
    assert.ok(!session || session.authState === 'AUTHENTICATION_REQUIRED' || session.isExpired);

    console.log('  ✓ PASSED: Confirmed token expiry invalidates session and transitions status to AUTHENTICATION_REQUIRED.');
  }

  // --------------------------------------------------------------------------
  // Scenario 4: Generic / Unexplained 403 (e.g. WAF Block / Rate Limit)
  // --------------------------------------------------------------------------
  console.log('\n[Scenario 4] Generic / Unexplained 403 (WAF Block / Rate Limit)...');
  {
    await resetAndAuthenticateUser();

    currentFetchResponse = {
      status: 403,
      ok: false,
      body: { message: 'HTTP 403', errorcode: '' },
    };

    try {
      await liveAngelOneAdapter.getPositions(userId, { connectionId: connId });
      assert.fail('getPositions should throw on generic 403');
    } catch (err: any) {
      assert.match(err.message, /SmartAPI getPosition.*HTTP 403/);
      assert.doesNotMatch(err.message, /Re-authentication required/);
      assert.doesNotMatch(err.message, /Invalid API key/);
    }

    // Session remains intact
    let session = await AngelOneSessionStore.loadSession(userId, { connectionId: connId });
    assert.ok(session, 'Session MUST remain intact on generic 403');
    assert.equal(session?.authState, 'AUTHENTICATED');

    let connStatus = await liveAngelOneAdapter.getConnectionStatus(userId, { connectionId: connId });
    assert.equal(connStatus.status, 'AUTHENTICATED');

    const capital = await liveAngelOneAdapter.getCapital(userId, { connectionId: connId });
    assert.equal(capital.connectionStatus, 'ERROR');
    assert.equal(capital.isStale, true);
    assert.equal(capital.netBalance, null);

    console.log('  ✓ PASSED: Generic 403 fails closed safely without invalidating session or mislabeling error state.');
  }

  // --------------------------------------------------------------------------
  // Scenario 5: Malformed Responses (Invalid JSON / Unexpected Data Types)
  // --------------------------------------------------------------------------
  console.log('\n[Scenario 5] Malformed Responses (Non-Array / Non-Object Data)...');
  {
    await resetAndAuthenticateUser();

    // getPositions returning non-array data
    currentFetchResponse = {
      status: 200,
      ok: true,
      body: { status: true, message: 'SUCCESS', data: 'MALFORMED_STRING_NOT_ARRAY' },
    };

    const positions = await liveAngelOneAdapter.getPositions(userId, { connectionId: connId });
    assert.deepEqual(positions, [], 'Malformed position payload MUST safely fallback to empty array');

    // getRMS returning non-object data
    currentFetchResponse = {
      status: 200,
      ok: true,
      body: { status: true, message: 'SUCCESS', data: null },
    };

    const capital = await liveAngelOneAdapter.getCapital(userId, { connectionId: connId });
    assert.equal(capital.connectionStatus, 'AUTHENTICATED');
    assert.equal(capital.netBalance, 0);

    let session = await AngelOneSessionStore.loadSession(userId, { connectionId: connId });
    assert.ok(session, 'Session MUST remain valid after malformed response handling');

    console.log('  ✓ PASSED: Malformed response payloads are safely handled without throwing or corrupting state.');
  }

  // --------------------------------------------------------------------------
  // Scenario 6: Network Failures / Timeouts
  // --------------------------------------------------------------------------
  console.log('\n[Scenario 6] Network Failures / Timeout Simulation...');
  {
    await resetAndAuthenticateUser();
    shouldSimulateNetworkError = true;

    try {
      await liveAngelOneAdapter.getPositions(userId, { connectionId: connId });
      assert.fail('getPositions should throw on network error');
    } catch (err: any) {
      assert.match(err.message, /Network timeout/);
    }

    const capital = await liveAngelOneAdapter.getCapital(userId, { connectionId: connId });
    assert.equal(capital.connectionStatus, 'ERROR');
    assert.equal(capital.isStale, true);
    assert.equal(capital.netBalance, null);

    let session = await AngelOneSessionStore.loadSession(userId, { connectionId: connId });
    assert.ok(session, 'Session MUST remain stored during transient network failures');

    let connStatus = await liveAngelOneAdapter.getConnectionStatus(userId, { connectionId: connId });
    assert.equal(connStatus.status, 'AUTHENTICATED', 'Connection status remains AUTHENTICATED on transient network error');

    console.log('  ✓ PASSED: Network failures preserve stored sessions and report stale/ERROR status.');
  }

  // --------------------------------------------------------------------------
  // Scenario 7: Polling Recovery after Explicit Re-Authentication
  // --------------------------------------------------------------------------
  console.log('\n[Scenario 7] Polling Recovery after Explicit Re-Authentication...');
  {
    // Start in AB1010 error state
    await resetAndAuthenticateUser();
    currentFetchResponse = {
      status: 403,
      ok: false,
      body: { message: 'Invalid Key', errorcode: 'AB1010' },
    };

    try {
      await liveAngelOneAdapter.getPositions(userId, { connectionId: connId });
    } catch {}

    let connStatus = await liveAngelOneAdapter.getConnectionStatus(userId, { connectionId: connId });
    assert.equal(connStatus.status, 'CONFIGURATION_ERROR');

    // Simulate login success / credential update clearing error state
    liveAngelOneAdapter.clearUserErrorState(userId, connId);
    shouldSimulateNetworkError = false;

    currentFetchResponse = {
      status: 200,
      ok: true,
      body: {
        status: true,
        message: 'SUCCESS',
        data: [{ exchange: 'NSE', tradingsymbol: 'SBIN-EQ', netqty: '100', avgprice: '600.00' }],
      },
    };

    const positions = await liveAngelOneAdapter.getPositions(userId, { connectionId: connId });
    assert.equal(positions.length, 1);
    assert.equal(positions[0].tradingsymbol, 'SBIN-EQ');

    connStatus = await liveAngelOneAdapter.getConnectionStatus(userId, { connectionId: connId });
    assert.equal(connStatus.status, 'AUTHENTICATED');

    console.log('  ✓ PASSED: Clearing error state and re-authenticating successfully resumes live polling.');
  }

  console.log('\n================================================================');
  console.log('ALL STAGE 2 POSITIONS & RMS TESTS PASSED SUCCESSFULLY (7/7)');
  console.log('================================================================\n');
}

runStage2PositionsRmsTests().catch((err) => {
  console.error('\nStage 2 Test Suite Failed:', err);
  process.exit(1);
});
