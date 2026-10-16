import { strict as assert } from 'assert';
import { apiRouter } from '../server/api';
import { ServerRiskStore, DEFAULT_ACCOUNT_ID, DEFAULT_ANGELONE_ACCOUNT_ID } from '../server/risk/store';
import { enableMockStoreForTesting, setAdminFirestoreForTesting } from '../server/brokers/zerodha/sessionStore';
import { getBrokerConnections } from '../src/services/brokerConnectionService';

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

async function runPhase7D3Acceptance() {
  console.log('================================================================');
  console.log('MONKTRADES PHASE 7D.3: ACCOUNT SELECTOR ACCEPTANCE VERIFICATION');
  console.log('================================================================\n');

  enableMockStoreForTesting(true);
  setAdminFirestoreForTesting(null);
  ServerRiskStore.reset();

  const stack = (apiRouter as any).stack;
  const findHandler = (method: string, path: string) => {
    const layer = stack.find(
      (l: any) => l.route?.path === path && l.route?.methods?.[method.toLowerCase()]
    );
    assert(layer !== undefined, `Found route handler for ${method} ${path}`);
    return layer.route.stack[layer.route.stack.length - 1].handle;
  };

  const getRiskConfigHandler = findHandler('GET', '/risk/config');
  const putRiskConfigHandler = findHandler('PUT', '/risk/config');

  const userId = 'user_p7d3_acceptance';

  // 1. Verify broker connections list lists all accounts including Angel One via client service function
  console.log('Test 1: Verify broker connections list lists all accounts including Angel One...');
  {
    const connections = await getBrokerConnections(userId);
    assert(Array.isArray(connections), 'Connections should be an array');
    
    const accountIds = connections.map((c: any) => c.connectionId);
    console.log('Discovered accountIds:', accountIds);
    assert(accountIds.includes('acc_mt_zerodha_default'), 'Includes Zerodha default');
    assert(accountIds.includes('acc_mt_angelone_default'), 'Includes Angel One default');
    console.log('✓ Test 1 Passed: All configured accounts returned successfully.');
  }

  // 2. Change daily loss limit for Zerodha default vs Angel One independently and verify persistence
  console.log('Test 2: Independent risk config persistence across accounts...');
  {
    const configZerodha = {
      dailyLossLimit: 15000,
      warningThreshold1: 65,
      warningThreshold2: 85,
      lockDurationMinutes: 120,
      lockDurationType: 'FIXED',
      includeRealisedPnl: true,
      includeUnrealisedPnl: true,
      enabled: true,
      broker: 'zerodha',
    };

    const reqPutZ: any = {
      method: 'PUT',
      url: '/risk/config',
      headers: { authorization: `Bearer ${userId}`, 'x-user-id': userId, 'x-account-id': DEFAULT_ACCOUNT_ID },
      query: { accountId: DEFAULT_ACCOUNT_ID },
      body: configZerodha,
    };
    const { res: resZ, getCaptured: getCapZ } = createMockRes();
    await putRiskConfigHandler(reqPutZ, resZ, () => {});
    assert.equal(getCapZ().code, 200);

    const configAngel = {
      dailyLossLimit: 8000,
      warningThreshold1: 50,
      warningThreshold2: 75,
      lockDurationMinutes: 60,
      lockDurationType: 'FIXED',
      includeRealisedPnl: true,
      includeUnrealisedPnl: true,
      enabled: true,
      broker: 'angelone',
    };

    const reqPutA: any = {
      method: 'PUT',
      url: '/risk/config',
      headers: { authorization: `Bearer ${userId}`, 'x-user-id': userId, 'x-account-id': DEFAULT_ANGELONE_ACCOUNT_ID },
      query: { accountId: DEFAULT_ANGELONE_ACCOUNT_ID },
      body: configAngel,
    };
    const { res: resA, getCaptured: getCapA } = createMockRes();
    await putRiskConfigHandler(reqPutA, resA, () => {});
    assert.equal(getCapA().code, 200);

    // Reload Zerodha config
    const reqGetZ: any = {
      method: 'GET',
      url: '/risk/config',
      headers: { authorization: `Bearer ${userId}`, 'x-user-id': userId, 'x-account-id': DEFAULT_ACCOUNT_ID },
      query: { accountId: DEFAULT_ACCOUNT_ID },
    };
    const { res: resGetZ, getCaptured: getCapGetZ } = createMockRes();
    await getRiskConfigHandler(reqGetZ, resGetZ, () => {});
    const zData = getCapGetZ().data.config || getCapGetZ().data;
    assert.equal(zData.dailyLossLimit, 15000);
    assert.equal(zData.warningThreshold1, 65);

    // Reload Angel One config
    const reqGetA: any = {
      method: 'GET',
      url: '/risk/config',
      headers: { authorization: `Bearer ${userId}`, 'x-user-id': userId, 'x-account-id': DEFAULT_ANGELONE_ACCOUNT_ID },
      query: { accountId: DEFAULT_ANGELONE_ACCOUNT_ID },
    };
    const { res: resGetA, getCaptured: getCapGetA } = createMockRes();
    await getRiskConfigHandler(reqGetA, resGetA, () => {});
    const aData = getCapGetA().data.config || getCapGetA().data;
    assert.equal(aData.dailyLossLimit, 8000);
    assert.equal(aData.warningThreshold1, 50);

    console.log('✓ Test 2 Passed: Independent configuration and isolation confirmed.');
  }

  console.log('\n================================================================');
  console.log('ALL PHASE 7D.3 ACCEPTANCE VERIFICATION TESTS PASSED SUCCESSFULLY!');
  console.log('================================================================');
}

runPhase7D3Acceptance().catch((err) => {
  console.error('Acceptance verification test failed:', err);
  process.exit(1);
});
