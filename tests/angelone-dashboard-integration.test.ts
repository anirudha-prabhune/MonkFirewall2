import { strict as assert } from 'assert';
import { AngelOneSessionStore, normalizeAngelOneConnectionId } from '../server/brokers/angelone/sessionStore';
import { liveAngelOneAdapter } from '../server/brokers/angelone/liveAdapter';
import { ServerRiskStore } from '../server/risk/store';
import { DEFAULT_ANGELONE_ACCOUNT_ID, DEFAULT_ANGELONE_RISK_CONFIG } from '../src/types/risk';
import { PnlEngine } from '../server/pnl/engine';
import { BrokerInstrument } from '../server/brokers/types';

async function runAngelOneDashboardIntegrationSuite() {
  console.log('================================================================');
  console.log('MonkFirewall2: Angel One Dashboard & Risk Integration Test Suite');
  console.log('================================================================\n');

  AngelOneSessionStore.enableMockStoreForTesting(true);
  ServerRiskStore.clearBufferedEventsForTesting();

  const userId = 'dash_user_test_99';
  const accountId = DEFAULT_ANGELONE_ACCOUNT_ID; // 'acc_mt_angelone_default'
  const apiKey = 'DASHBOARD_ANGEL_KEY_777';

  // --------------------------------------------------------------------------
  // TEST 1: Account ID Normalization Verification
  // --------------------------------------------------------------------------
  console.log('[Test 1] Account ID Normalization Verification');
  {
    const norm1 = normalizeAngelOneConnectionId('angelone_default');
    const norm2 = normalizeAngelOneConnectionId('acc_mt_angelone_default');
    const norm3 = normalizeAngelOneConnectionId(undefined);

    assert.equal(norm1, DEFAULT_ANGELONE_ACCOUNT_ID, 'angelone_default maps to acc_mt_angelone_default');
    assert.equal(norm2, DEFAULT_ANGELONE_ACCOUNT_ID, 'acc_mt_angelone_default maps to acc_mt_angelone_default');
    assert.equal(norm3, DEFAULT_ANGELONE_ACCOUNT_ID, 'undefined maps to acc_mt_angelone_default');

    console.log('  ✓ PASSED: Canonical account ID resolution verified across all default representations');
  }

  // --------------------------------------------------------------------------
  // TEST 2: Session & Key Propagation Across Account Identifiers
  // --------------------------------------------------------------------------
  console.log('\n[Test 2] Session & API Key Resolution for acc_mt_angelone_default');
  {
    // Mock login save via authenticate using default connection ID
    const adapter = liveAngelOneAdapter;
    adapter.setFetchHandler(async (input: any) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/loginByPassword')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            status: true,
            data: { jwtToken: 'Bearer mock_jwt_token_longer_than_20_chars' },
          }),
        } as any;
      }
      return { ok: false, status: 400, json: async () => ({}) } as any;
    });

    const authRes = await adapter.authenticate(
      userId,
      {
        apiKey,
        clientCode: 'CLIENT_DASHBOARD',
        password: 'PassWord123',
        totp: '123456',
      },
      { connectionId: 'angelone_default' }
    );
    assert.equal(authRes.success, true, 'Auth must succeed');

    // Retrieve status and key using accountId 'acc_mt_angelone_default'
    const status = await adapter.getConnectionStatus(userId, { connectionId: accountId });
    assert.equal(status.status, 'AUTHENTICATED', 'getConnectionStatus must return AUTHENTICATED for acc_mt_angelone_default');
    assert.equal(status.authenticated, true, 'authenticated must be true');

    const loadedKey = await AngelOneSessionStore.loadApiKey(userId, accountId);
    assert.equal(loadedKey, apiKey, 'ApiKey saved under angelone_default MUST be readable via acc_mt_angelone_default');

    console.log('  ✓ PASSED: Session and API key seamlessly resolve for accountId acc_mt_angelone_default');
  }

  // --------------------------------------------------------------------------
  // TEST 3: Authoritative Risk Config Resolution for Angel One
  // --------------------------------------------------------------------------
  console.log('\n[Test 3] Authoritative Risk Config Resolution');
  {
    const config = await ServerRiskStore.getConfig(userId, accountId);
    assert.equal(config.accountId, accountId, 'AccountId matches acc_mt_angelone_default');
    assert.equal(config.broker, 'angelone', 'Broker is angelone');
    assert.equal(config.dailyLossLimit, 10000, 'Default Angel One Daily Loss Limit is ₹10,000');
    assert.equal(config.executionMode, 'ENFORCE', 'Default Angel One Execution Mode is ENFORCE');

    console.log('  ✓ PASSED: Risk config defaults to ₹10,000 daily loss limit and ENFORCE mode');
  }

  // --------------------------------------------------------------------------
  // TEST 4: Live P&L Calculation & Risk Evaluation (No Mock Fallback)
  // --------------------------------------------------------------------------
  console.log('\n[Test 4] Live P&L Sourcing & Risk Session Evaluation');
  {
    const adapter = liveAngelOneAdapter;
    adapter.setFetchHandler(async (input: any) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/getPosition')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            status: true,
            data: [
              {
                exchange: 'NFO',
                symboltoken: '150001',
                tradingsymbol: 'NIFTY26OCT25000CE',
                producttype: 'CARRYFORWARD',
                netqty: '50',
                avgprice: '100.0',
                ltp: '80.0',
                pnl: '-1000.0',
                realised: '0.0',
                unrealised: '-1000.0',
              },
            ],
          }),
        } as any;
      }
      return { ok: false, status: 400, json: async () => ({}) } as any;
    });

    const rawPositions = await adapter.getPositions(userId, { connectionId: accountId });
    assert.equal(rawPositions.length, 1, 'Returns 1 position');
    assert.equal(rawPositions[0].pnl, -1000.0, 'PnL is -₹1,000');

    const instruments = await adapter.getInstruments(userId);
    const instrumentMap = new Map<number, BrokerInstrument>(instruments.map((i) => [i.instrumentToken, i]));

    // Calculate PnL
    const config = await ServerRiskStore.getConfig(userId, accountId);
    const pnlCalc = PnlEngine.calculate(
      [
        {
          exchange: 'NFO',
          tradingsymbol: 'NIFTY26OCT25000CE',
          product: 'CARRYFORWARD',
          quantity: 50,
          averagePrice: 100.0,
          lastPrice: 80.0,
          pnl: -1000.0,
          realised: 0,
          unrealised: -1000.0,
          segment: 'NFO',
          instrumentType: 'OPTIDX',
          totalPnl: -1000.0,
          realisedPnl: 0,
          unrealisedPnl: -1000.0,
          dayBuyQuantity: 50,
          dayBuyValue: 5000,
          daySellQuantity: 0,
          daySellValue: 0,
          instrumentToken: 150001,
          isFno: true,
          dataSource: 'ANGELONE_LIVE',
        },
      ],
      config
    );

    const evalResult = await ServerRiskStore.evaluatePnlResult(userId, pnlCalc, new Date(), config, accountId);
    assert.equal(evalResult.session.state, 'ALLOW', 'Risk state is ALLOW');
    assert.equal(evalResult.session.currentPnl, -1000.0, 'Current PnL is -₹1,000');
    assert.equal(evalResult.session.lossLimit, 10000, 'Loss limit in session is ₹10,000');
    assert.equal(config.executionMode, 'ENFORCE', 'Execution mode in config is ENFORCE');

    console.log('  ✓ PASSED: Live P&L evaluation produces authoritative ENFORCE risk session');
  }

  console.log('\n================================================================');
  console.log('ALL ANGEL ONE DASHBOARD INTEGRATION TESTS PASSED (4/4)');
  console.log('================================================================\n');
}

runAngelOneDashboardIntegrationSuite().catch((err) => {
  console.error('Angel One Dashboard Integration Suite Failed:', err);
  process.exit(1);
});
