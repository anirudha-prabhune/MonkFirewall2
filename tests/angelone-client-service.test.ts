import {
  fetchAngelOneStatus,
  fetchAngelOnePositions,
  authenticateAngelOneSession,
  disconnectAngelOneSession,
} from '../src/services/liveBrokerService';

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: any;
}

async function runClientServiceTests() {
  console.log('================================================================');
  console.log('Angel One Client-Service Test Suite (Focused Frontend Services)');
  console.log('================================================================');

  const originalFetch = global.fetch;
  let captured: CapturedRequest[] = [];
  let mockResponseGenerator: (url: string, options?: any) => Promise<any> = async () => ({
    ok: true,
    json: async () => ({}),
  });

  // Mock global.fetch without making live network calls
  global.fetch = (async (url: any, options: any = {}) => {
    const rawHeaders: any = options.headers || {};
    const parsedHeaders: Record<string, string> = {};
    if (typeof rawHeaders.forEach === 'function') {
      rawHeaders.forEach((val: string, key: string) => {
        parsedHeaders[key.toLowerCase()] = val;
      });
    } else {
      Object.entries(rawHeaders).forEach(([k, v]) => {
        parsedHeaders[k.toLowerCase()] = String(v);
      });
    }

    let parsedBody = null;
    if (options.body) {
      try {
        parsedBody = JSON.parse(options.body);
      } catch {
        parsedBody = options.body;
      }
    }

    captured.push({
      url: String(url),
      method: (options.method || 'GET').toUpperCase(),
      headers: parsedHeaders,
      body: parsedBody,
    });

    return await mockResponseGenerator(String(url), options);
  }) as any;

  try {
    // --------------------------------------------------------------------------
    // Test 1: fetchAngelOneStatus - HTTP method, URL, headers, and response
    // --------------------------------------------------------------------------
    console.log('\n[Test 1] fetchAngelOneStatus Contract Verification');
    captured = [];
    mockResponseGenerator = async () => ({
      ok: true,
      json: async () => ({
        broker: 'angelone',
        status: 'AUTHENTICATED',
        isMock: false,
        message: 'Angel One SmartAPI connection active',
        timestamp: '2026-10-13T10:00:00.000Z',
        configured: true,
        authenticated: true,
        authenticationRequired: false,
      }),
    });

    const statusRes = await fetchAngelOneStatus('trader-user-001');
    assert(captured.length === 1, 'Exactly one HTTP request must be dispatched');
    assert(captured[0].method === 'GET', 'Method must be GET');
    assert(captured[0].url === '/api/broker/angelone/live/status', 'URL must match /api/broker/angelone/live/status');
    assert(captured[0].headers['x-user-id'] === 'trader-user-001', 'x-user-id header must match trader-user-001');
    assert(statusRes !== null, 'Response must not be null');
    assert(statusRes?.broker === 'angelone', 'Response broker must be angelone');
    assert(statusRes?.authenticated === true, 'Response authenticated must be true');
    console.log('  ✓ PASSED: GET /api/broker/angelone/live/status verified with headers and payload');

    // --------------------------------------------------------------------------
    // Test 2: fetchAngelOneStatus - Error handling on non-OK and network failure
    // --------------------------------------------------------------------------
    console.log('\n[Test 2] fetchAngelOneStatus Error Handling (Fail-Closed)');
    captured = [];
    mockResponseGenerator = async () => ({
      ok: false,
      status: 500,
      json: async () => ({ error: 'Internal server error' }),
    });
    const errorStatusRes = await fetchAngelOneStatus('trader-user-001');
    assert(errorStatusRes === null, 'Must return null on HTTP 500 without crashing');

    mockResponseGenerator = async () => {
      throw new Error('Network connection timeout');
    };
    const networkErrorStatusRes = await fetchAngelOneStatus('trader-user-001');
    assert(networkErrorStatusRes === null, 'Must return null on network exception without crashing');
    console.log('  ✓ PASSED: fetchAngelOneStatus fails closed gracefully on error/exception');

    // --------------------------------------------------------------------------
    // Test 3: fetchAngelOnePositions - HTTP method, URL, headers, and dataSource
    // --------------------------------------------------------------------------
    console.log('\n[Test 3] fetchAngelOnePositions Contract & dataSource Verification');
    captured = [];
    mockResponseGenerator = async () => ({
      ok: true,
      json: async () => ({
        broker: 'angelone',
        connectionStatus: 'AUTHENTICATED',
        dataSource: 'ANGELONE_LIVE',
        positionCount: 1,
        fnoPositionCount: 1,
        positions: [
          {
            instrumentToken: 99901,
            exchange: 'NFO',
            tradingsymbol: 'BANKNIFTY26OCT52000CE',
            segment: 'NFO-OPT',
            product: 'NRML',
            quantity: 15,
            averagePrice: 150.0,
            lastPrice: 165.0,
            realisedPnl: 0,
            unrealisedPnl: 225.0,
            totalPnl: 225.0,
            isFno: true,
            dataSource: 'ANGELONE_LIVE',
          },
        ],
        timestamp: '2026-10-13T10:00:00.000Z',
        diagnosticNote: 'Positions normalized via Angel One live adapter',
      }),
    });

    const positionsRes = await fetchAngelOnePositions('trader-user-001');
    assert(captured.length === 1, 'Exactly one request dispatched');
    assert(captured[0].method === 'GET', 'Method must be GET');
    assert(captured[0].url === '/api/broker/angelone/live/positions', 'URL must match /api/broker/angelone/live/positions');
    assert(captured[0].headers['x-user-id'] === 'trader-user-001', 'x-user-id must match trader-user-001');
    assert(positionsRes !== null, 'Positions response must not be null');
    assert(positionsRes?.dataSource === 'ANGELONE_LIVE', 'dataSource must be ANGELONE_LIVE');
    assert(positionsRes?.positions[0].dataSource === 'ANGELONE_LIVE', 'Position item dataSource must be ANGELONE_LIVE');
    assert(positionsRes?.positions[0].isFno === true, 'F&O position must be tagged isFno: true');
    console.log('  ✓ PASSED: GET /api/broker/angelone/live/positions verified with ANGELONE_LIVE dataSource');

    // --------------------------------------------------------------------------
    // Test 4: authenticateAngelOneSession - Request payload and success response
    // --------------------------------------------------------------------------
    console.log('\n[Test 4] authenticateAngelOneSession Payload & Success Handling');
    captured = [];
    mockResponseGenerator = async () => ({
      ok: true,
      json: async () => ({
        success: true,
        sessionVersion: 1,
        authState: 'AUTHENTICATED',
      }),
    });

    const authCreds = {
      clientCode: 'ANGEL_CLIENT_100',
      password: 'SafePassword123',
      totp: '654321',
      apiKey: 'test_smartapi_key',
    };
    const authResult = await authenticateAngelOneSession(authCreds, 'trader-user-001');
    assert(captured.length === 1, 'Exactly one POST request dispatched');
    assert(captured[0].method === 'POST', 'Method must be POST');
    assert(captured[0].url === '/api/broker/angelone/live/auth/session', 'URL must match /api/broker/angelone/live/auth/session');
    assert(captured[0].headers['content-type'] === 'application/json', 'Content-Type must be application/json');
    assert(captured[0].headers['x-user-id'] === 'trader-user-001', 'x-user-id header must be passed');
    assert(captured[0].body.clientCode === 'ANGEL_CLIENT_100', 'clientCode in payload must match');
    assert(captured[0].body.password === 'SafePassword123', 'password in payload must match');
    assert(captured[0].body.totp === '654321', 'totp in payload must match');
    assert(captured[0].body.apiKey === 'test_smartapi_key', 'apiKey in payload must match');
    assert(authResult.success === true, 'authResult must be success: true');
    console.log('  ✓ PASSED: authenticateAngelOneSession serializes full payload and parses success');

    // --------------------------------------------------------------------------
    // Test 5: authenticateAngelOneSession - Error handling
    // --------------------------------------------------------------------------
    console.log('\n[Test 5] authenticateAngelOneSession Error & Rejection Handling');
    captured = [];
    mockResponseGenerator = async () => ({
      ok: false,
      status: 401,
      json: async () => ({
        success: false,
        error: 'Invalid TOTP or credentials rejected by broker',
      }),
    });

    const failedAuthResult = await authenticateAngelOneSession(
      { clientCode: 'BAD_CLIENT', totp: '000000' },
      'trader-user-001'
    );
    assert(failedAuthResult.success === false, 'Failed auth must return success: false');
    assert(failedAuthResult.error === 'Invalid TOTP or credentials rejected by broker', 'Error message must match backend');

    // Network error handling
    mockResponseGenerator = async () => {
      throw new Error('Connection refused to auth gateway');
    };
    const networkFailResult = await authenticateAngelOneSession(
      { clientCode: 'ANY_CLIENT' },
      'trader-user-001'
    );
    assert(networkFailResult.success === false, 'Network exception must return success: false');
    assert(Boolean(networkFailResult.error?.includes('Connection refused')), 'Error message must describe network exception');
    console.log('  ✓ PASSED: authenticateAngelOneSession error paths and network exceptions handled cleanly');

    // --------------------------------------------------------------------------
    // Test 6: disconnectAngelOneSession - Contract and semantics
    // --------------------------------------------------------------------------
    console.log('\n[Test 6] disconnectAngelOneSession Contract Verification');
    captured = [];
    mockResponseGenerator = async () => ({
      ok: true,
      json: async () => ({
        success: true,
        status: 'AUTHENTICATION_REQUIRED',
        message: 'Angel One session invalidated.',
      }),
    });

    const disconnectSuccess = await disconnectAngelOneSession('trader-user-001');
    assert(captured.length === 1, 'Exactly one request dispatched');
    assert(captured[0].method === 'POST', 'Method must be POST');
    assert(captured[0].url === '/api/broker/angelone/live/auth/disconnect', 'URL must match /api/broker/angelone/live/auth/disconnect');
    assert(captured[0].headers['x-user-id'] === 'trader-user-001', 'x-user-id header must be scoped');
    assert(disconnectSuccess === true, 'Must return true on success');

    // Disconnect failure case
    mockResponseGenerator = async () => ({
      ok: false,
      status: 500,
      json: async () => ({ error: 'Failed to disconnect session' }),
    });
    const disconnectFailed = await disconnectAngelOneSession('trader-user-001');
    assert(disconnectFailed === false, 'Must return false on HTTP error');

    // Disconnect exception case
    mockResponseGenerator = async () => {
      throw new Error('Network timeout during disconnect');
    };
    const disconnectException = await disconnectAngelOneSession('trader-user-001');
    assert(disconnectException === false, 'Must return false on network exception');
    console.log('  ✓ PASSED: POST /api/broker/angelone/live/auth/disconnect semantics verified');

    // --------------------------------------------------------------------------
    // Test 7: Multi-User Session Scoping Isolation
    // --------------------------------------------------------------------------
    console.log('\n[Test 7] Multi-User Header & Session Scoping Isolation');
    captured = [];
    mockResponseGenerator = async () => ({
      ok: true,
      json: async () => ({ broker: 'angelone', status: 'AUTHENTICATED' }),
    });

    await fetchAngelOneStatus('alice_user');
    await fetchAngelOneStatus('bob_user');
    assert(captured.length === 2, 'Two calls captured');
    assert(captured[0].headers['x-user-id'] === 'alice_user', 'First call scoped to alice_user');
    assert(captured[1].headers['x-user-id'] === 'bob_user', 'Second call scoped to bob_user');
    const aliceScope: string = captured[0].headers['x-user-id'];
    const bobScope: string = captured[1].headers['x-user-id'];
    assert(aliceScope !== bobScope, 'Sessions cannot leak across user boundaries');
    console.log('  ✓ PASSED: Scoped x-user-id headers strictly isolated per user');

    console.log('\n================================================================');
    console.log('ALL ANGEL ONE CLIENT-SERVICE TESTS PASSED (7/7)');
    console.log('================================================================');
  } finally {
    global.fetch = originalFetch;
  }
}

runClientServiceTests().catch((err) => {
  console.error('\nCLIENT-SERVICE TEST FAILED:', err);
  process.exit(1);
});
