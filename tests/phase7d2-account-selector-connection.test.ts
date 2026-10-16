import { strict as assert } from 'assert';
import { apiRouter } from '../server/api';
import { ServerRiskStore, DEFAULT_ACCOUNT_ID, DEFAULT_ANGELONE_ACCOUNT_ID } from '../server/risk/store';
import { setAdminFirestoreForTesting, enableMockStoreForTesting } from '../server/brokers/zerodha/sessionStore';
import { getBrokerConnections } from '../src/services/brokerConnectionService';
import { DEFAULT_RISK_CONFIG } from '../src/types/risk';

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
    end: () => {},
  };
  return {
    res,
    getCaptured: () => ({ code: capturedCode, data: capturedData }),
  };
}

async function runPhase7D2Tests() {
  console.log('================================================================');
  console.log('MONKTRADES PHASE 7D.2: ACCOUNT SELECTOR & CONNECTION STATUS SUITE');
  console.log('Account Discovery, Independent Persistence & Status Reconciliation');
  console.log('================================================================');

  enableMockStoreForTesting(true);
  setAdminFirestoreForTesting(null);
  ServerRiskStore.reset();

  const userId = 'user_p7d2_test';

  const stack = (apiRouter as any).stack;
  const findHandler = (method: string, path: string) => {
    const layer = stack.find(
      (l: any) => l.route?.path === path && l.route?.methods?.[method.toLowerCase()]
    );
    assert(layer !== undefined, `Found route handler for ${method} ${path}`);
    return layer.route.stack[layer.route.stack.length - 1].handle;
  };

  const getRiskConfigHandler = findHandler('GET', '/risk/config');

  // TEST 1: Broker Connections discovery returns Zerodha and Angel One accounts
  try {
    const connections = await getBrokerConnections(userId);
    assert(connections.length >= 2, 'Should return at least 2 configured accounts');
    const hasZerodhaPrimary = connections.some(c => c.connectionId === DEFAULT_ACCOUNT_ID && c.connection.broker === 'zerodha');
    const hasAngelOne = connections.some(c => c.connectionId === DEFAULT_ANGELONE_ACCOUNT_ID && c.connection.broker === 'angelone');

    assert(hasZerodhaPrimary, 'Zerodha account must be present');
    assert(hasAngelOne, 'Angel One default account must be present');
    console.log('  ✓ PASSED: GetBrokerConnections returns configured accounts including Angel One');
  } catch (err) {
    console.error('  ✗ FAILED TEST 1:', err);
    process.exit(1);
  }

  // TEST 2: Independent configuration load & save across accounts
  try {
    await ServerRiskStore.saveConfig(userId, {
      ...DEFAULT_RISK_CONFIG,
      dailyLossLimit: 12000,
      lockDurationMinutes: 60,
      executionMode: 'ENFORCE',
      accountId: DEFAULT_ACCOUNT_ID,
      broker: 'zerodha',
    }, DEFAULT_ACCOUNT_ID);

    await ServerRiskStore.saveConfig(userId, {
      ...DEFAULT_RISK_CONFIG,
      dailyLossLimit: 20000,
      lockDurationMinutes: 60,
      executionMode: 'ENFORCE',
      accountId: DEFAULT_ANGELONE_ACCOUNT_ID,
      broker: 'angelone',
    }, DEFAULT_ANGELONE_ACCOUNT_ID);

    const cfgZerodha = await ServerRiskStore.getConfig(userId, DEFAULT_ACCOUNT_ID);
    const cfgAngel = await ServerRiskStore.getConfig(userId, DEFAULT_ANGELONE_ACCOUNT_ID);

    assert.equal(cfgZerodha.dailyLossLimit, 12000);
    assert.equal(cfgZerodha.executionMode, 'ENFORCE');

    assert.equal(cfgAngel.dailyLossLimit, 20000);
    assert.equal(cfgAngel.executionMode, 'OBSERVE_ONLY', 'Angel One must remain strictly OBSERVE_ONLY');

    console.log('  ✓ PASSED: Independent configuration persistence per account with Angel One protection enforced');
  } catch (err) {
    console.error('  ✗ FAILED TEST 2:', err);
    process.exit(1);
  }

  // TEST 3: API endpoints for risk config load with accountId query param
  try {
    const { res, getCaptured } = createMockRes();
    const req: any = {
      headers: {
        authorization: `Bearer ${userId}`,
        'x-user-id': userId,
        'x-account-id': DEFAULT_ACCOUNT_ID,
      },
      query: { accountId: DEFAULT_ACCOUNT_ID },
    };

    await getRiskConfigHandler(req, res, () => {});
    const cap = getCaptured();
    assert.equal(cap.code, 200);
    assert.equal(cap.data.dailyLossLimit, 12000);

    console.log('  ✓ PASSED: API risk config GET endpoint respects accountId parameter');
  } catch (err) {
    console.error('  ✗ FAILED TEST 3:', err);
    process.exit(1);
  }

  console.log('================================================================');
  console.log('PHASE 7D.2 TEST SUITE COMPLETE: ALL TESTS PASSED SUCCESSFULLY');
  console.log('================================================================');
}

runPhase7D2Tests().catch((err) => {
  console.error('Phase 7D.2 test execution failed:', err);
  process.exit(1);
});
