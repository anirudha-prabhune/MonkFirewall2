import { strict as assert } from 'assert';
import express from 'express';
import { apiRouter } from '../server/api';
import { ZerodhaSessionStore, enableMockStoreForTesting, clearMockStore } from '../server/brokers/zerodha/sessionStore';
import { liveZerodhaAdapter } from '../server/brokers/zerodha/liveAdapter';
import { mockZerodhaAdapter } from '../server/brokers/mock/adapter';

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

  const urlParts = options.url.split('?');
  const path = urlParts[0];
  const queryStr = urlParts[1] || '';
  const query: Record<string, string> = {};
  if (queryStr) {
    const params = new URLSearchParams(queryStr);
    params.forEach((value, key) => {
      query[key] = value;
    });
  }

  const req: any = {
    method: options.method,
    url: options.url,
    originalUrl: options.url,
    baseUrl: '',
    path,
    query,
    headers: { ...(options.headers || {}) },
    body: options.body || {},
  };

  return new Promise<{ code: number; data: any }>((resolve, reject) => {
    let resolved = false;
    const done = (code: number, data: any) => {
      if (!resolved) {
        resolved = true;
        resolve({ code, data });
      }
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
        done(capturedCode, capturedData);
        return res;
      },
      setHeader: () => res,
      send: (data: any) => {
        capturedData = data;
        done(capturedCode, capturedData);
        return res;
      },
      end: (data: any) => {
        if (data && !capturedData) capturedData = data;
        done(capturedCode, capturedData);
        return res;
      },
    };

    app(req, res, (err: any) => {
      if (err) reject(err);
      else done(capturedCode, capturedData);
    });
  });
}

async function runCapitalRoutingRegressionSuite() {
  console.log('================================================================');
  console.log('MonkTrades Phase 5C.2.1: Capital Endpoint Routing Regression Suite');
  console.log('================================================================\n');

  const app = express();
  app.use(express.json());
  app.use('/api', apiRouter);

  // Set test environment variables for Zerodha configuration
  process.env.NODE_ENV = 'test';
  process.env.ZERODHA_API_KEY = 'test_api_key_p5c';
  process.env.ZERODHA_API_SECRET = 'test_api_secret_p5c';

  // Enable in-memory mock store for isolated offline test execution
  enableMockStoreForTesting(true);
  clearMockStore();

  // Inject offline mock fetch handler for liveZerodhaAdapter
  liveZerodhaAdapter.setFetchHandler(async (url: string) => {
    if (url.includes('/user/profile')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ status: 'success', data: { user_id: 'ZER123' } }),
      };
    }
    if (url.includes('/user/margins')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          status: 'success',
          data: {
            equity: {
              net: 250000.0,
              available: { cash: 200000.0, live_balance: 250000.0 },
              utilised: { debits: 50000.0 },
            },
          },
        }),
      };
    }
    return {
      ok: false,
      status: 404,
      json: async () => ({ status: 'error', message: 'Not found' }),
    };
  });

  // --------------------------------------------------------------------------
  // TEST 1: Authenticated request dispatches to liveZerodhaAdapter
  // --------------------------------------------------------------------------
  console.log('[Test 1] Authenticated /api/broker/live/capital dispatches to liveZerodhaAdapter');
  {
    const userId = 'user_live_test_1';
    await ZerodhaSessionStore.saveSession(userId, 'valid_live_access_token_123');

    const res = await invokeExpress(app, {
      method: 'GET',
      url: '/api/broker/live/capital',
      headers: {
        authorization: `Bearer ${userId}`,
      },
    });

    assert.equal(res.code, 200, 'HTTP status must be 200 OK');
    assert.equal(res.data.success, true, 'Response success must be true');
    assert.equal(res.data.broker, 'zerodha', 'Broker mode must be zerodha');
    assert.ok(res.data.capital, 'Capital object must be present');
    assert.equal(res.data.capital.broker, 'zerodha', 'Capital broker must be zerodha');
    assert.equal(res.data.capital.dataSource, 'ZERODHA_LIVE', 'dataSource must be ZERODHA_LIVE');
    assert.equal(res.data.capital.netBalance, 250000.0, 'Net balance must match live adapter margins payload');
    assert.notEqual(res.data.capital.dataSource, 'MOCK_DATA', 'dataSource MUST NOT be MOCK_DATA');
    console.log('  ✓ PASSED: Authenticated request dispatches to liveZerodhaAdapter and returns ZERODHA_LIVE');
  }

  // --------------------------------------------------------------------------
  // TEST 2: Mode=mock query parameter explicitly selects Mock mode
  // --------------------------------------------------------------------------
  console.log('\n[Test 2] Authenticated /api/broker/live/capital?mode=mock dispatches to mockZerodhaAdapter');
  {
    mockZerodhaAdapter.setConnected(true);
    const userId = 'user_live_test_1';

    const res = await invokeExpress(app, {
      method: 'GET',
      url: '/api/broker/live/capital?mode=mock',
      headers: {
        authorization: `Bearer ${userId}`,
      },
    });

    assert.equal(res.code, 200, 'HTTP status must be 200 OK');
    assert.equal(res.data.success, true, 'Response success must be true');
    assert.equal(res.data.broker, 'mock', 'Broker mode must be mock');
    assert.ok(res.data.capital, 'Capital object must be present');
    assert.equal(res.data.capital.broker, 'mock', 'Capital broker must be mock');
    assert.equal(res.data.capital.dataSource, 'MOCK_DATA', 'dataSource must be MOCK_DATA');
    assert.equal(res.data.capital.netBalance, 500000, 'Net balance must be 500,000 for mock mode');
    console.log('  ✓ PASSED: mode=mock query parameter explicitly routes to mockZerodhaAdapter');
  }

  // --------------------------------------------------------------------------
  // TEST 3: Broker=mock query parameter explicitly selects Mock mode
  // --------------------------------------------------------------------------
  console.log('\n[Test 3] Authenticated /api/broker/live/capital?broker=mock dispatches to mockZerodhaAdapter');
  {
    mockZerodhaAdapter.setConnected(true);
    const userId = 'user_live_test_1';

    const res = await invokeExpress(app, {
      method: 'GET',
      url: '/api/broker/live/capital?broker=mock',
      headers: {
        authorization: `Bearer ${userId}`,
      },
    });

    assert.equal(res.code, 200, 'HTTP status must be 200 OK');
    assert.equal(res.data.success, true, 'Response success must be true');
    assert.equal(res.data.broker, 'mock', 'Broker mode must be mock');
    assert.ok(res.data.capital, 'Capital object must be present');
    assert.equal(res.data.capital.dataSource, 'MOCK_DATA', 'dataSource must be MOCK_DATA');
    assert.equal(res.data.capital.netBalance, 500000, 'Net balance must be 500,000 for mock mode');
    console.log('  ✓ PASSED: broker=mock query parameter explicitly routes to mockZerodhaAdapter');
  }

  // --------------------------------------------------------------------------
  // TEST 4: Missing or invalid authentication prevents capital retrieval
  // --------------------------------------------------------------------------
  console.log('\n[Test 4] Missing or invalid authentication prevents capital retrieval');
  {
    // 4a. Missing Authorization header
    const resNoAuth = await invokeExpress(app, {
      method: 'GET',
      url: '/api/broker/live/capital',
    });
    assert.equal(resNoAuth.code, 401, 'Missing auth header must return 401 Unauthorized');
    assert.equal(resNoAuth.data?.error, 'UNAUTHENTICATED', 'Error code must be UNAUTHENTICATED');
    assert.equal(resNoAuth.data?.capital, undefined, 'No capital object must be returned');

    // 4b. Invalid/forged token
    const resInvalidAuth = await invokeExpress(app, {
      method: 'GET',
      url: '/api/broker/live/capital',
      headers: {
        authorization: 'Bearer invalid_forged_token_99',
      },
    });
    assert.equal(resInvalidAuth.code, 401, 'Invalid bearer token must return 401 Unauthorized');
    assert.equal(resInvalidAuth.data?.error, 'UNAUTHENTICATED', 'Error code must be UNAUTHENTICATED');
    assert.equal(resInvalidAuth.data?.capital, undefined, 'No capital object must be returned');
    console.log('  ✓ PASSED: Missing and invalid authentication strictly fail closed at 401 Unauthorized');
  }

  // --------------------------------------------------------------------------
  // TEST 5: Live-adapter failure returns unavailable/error response (never mock capital)
  // --------------------------------------------------------------------------
  console.log('\n[Test 5] Live-adapter failure returns unavailable/error response (never mock capital)');
  {
    const unauthenticatedUser = 'user_no_session_77';

    const res = await invokeExpress(app, {
      method: 'GET',
      url: '/api/broker/live/capital',
      headers: {
        authorization: `Bearer ${unauthenticatedUser}`,
      },
    });

    assert.equal(res.code, 200, 'HTTP status must be 200 OK with error payload');
    assert.equal(res.data.success, true, 'Request processed');
    assert.equal(res.data.broker, 'zerodha', 'Broker mode must remain zerodha');
    assert.ok(res.data.capital, 'Capital object must be returned');
    assert.equal(res.data.capital.dataSource, 'ZERODHA_LIVE', 'dataSource must remain ZERODHA_LIVE');
    assert.equal(res.data.capital.connectionStatus, 'AUTHENTICATION_REQUIRED', 'connectionStatus must be AUTHENTICATION_REQUIRED');
    assert.equal(res.data.capital.netBalance, null, 'netBalance must be null');
    assert.equal(res.data.capital.availableCash, null, 'availableCash must be null');
    assert.equal(res.data.capital.availableTradingMargin, null, 'availableTradingMargin must be null');
    assert.equal(res.data.capital.utilizedMargin, null, 'utilizedMargin must be null');
    assert.equal(res.data.capital.isStale, true, 'isStale must be true');
    assert.notEqual(res.data.capital.dataSource, 'MOCK_DATA', 'MUST NOT substitute MOCK_DATA');
    assert.notEqual(res.data.capital.netBalance, 500000, 'MUST NOT substitute mock balance 500,000');
    assert.notEqual(res.data.capital.netBalance, 125000.5, 'MUST NOT substitute preview sample balance 125,000.5');
    console.log('  ✓ PASSED: Live failure returns connectionStatus: AUTHENTICATION_REQUIRED with null balances');
  }

  // --------------------------------------------------------------------------
  // TEST 6: User identity isolation prevents cross-user session or capital leakage
  // --------------------------------------------------------------------------
  console.log('\n[Test 6] User identity isolation prevents cross-user session or capital leakage');
  {
    const userAlpha = 'user_identity_alpha';
    const userBeta = 'user_identity_beta';

    // Create active session only for user_identity_alpha
    await ZerodhaSessionStore.saveSession(userAlpha, 'token_alpha_secret_xyz');

    // Query for user_identity_alpha
    const resAlpha = await invokeExpress(app, {
      method: 'GET',
      url: '/api/broker/live/capital',
      headers: {
        authorization: `Bearer ${userAlpha}`,
      },
    });
    assert.equal(resAlpha.data.capital.dataSource, 'ZERODHA_LIVE', 'Alpha receives ZERODHA_LIVE');
    assert.equal(resAlpha.data.capital.netBalance, 250000.0, 'Alpha receives 250,000 live balance');

    // Query for user_identity_beta (who has no session)
    const resBeta = await invokeExpress(app, {
      method: 'GET',
      url: '/api/broker/live/capital',
      headers: {
        authorization: `Bearer ${userBeta}`,
      },
    });

    assert.equal(resBeta.data.capital.connectionStatus, 'AUTHENTICATION_REQUIRED', 'Beta receives AUTHENTICATION_REQUIRED');
    assert.equal(resBeta.data.capital.netBalance, null, 'Beta receives null netBalance');
    assert.notEqual(resBeta.data.capital.netBalance, resAlpha.data.capital.netBalance, 'Alpha and Beta balances MUST NOT match');
    console.log('  ✓ PASSED: Authenticated user isolation verified with zero session or capital leakage');
  }

  console.log('\n================================================================');
  console.log('ALL CAPITAL ROUTING REGRESSION TESTS PASSED (6/6)');
  console.log('================================================================\n');
}

runCapitalRoutingRegressionSuite().catch((err) => {
  console.error('Capital Routing Regression Test Suite Failed:', err);
  process.exit(1);
});
