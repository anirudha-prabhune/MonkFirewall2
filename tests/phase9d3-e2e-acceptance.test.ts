import { strict as assert } from 'assert';
import { AngelOneSessionStore } from '../server/brokers/angelone/sessionStore';
import { liveAngelOneAdapter, LiveAngelOneAdapter } from '../server/brokers/angelone/liveAdapter';
import { ServerRiskStore } from '../server/risk/store';
import { DEFAULT_ANGELONE_ACCOUNT_ID, DEFAULT_ACCOUNT_ID } from '../src/types/risk';
import { PnlEngine } from '../server/pnl/engine';
import { BrokerInstrument } from '../server/brokers/types';

async function runPhase9d3E2eAcceptanceSuite() {
  console.log('================================================================');
  console.log('MonkFirewall2 — Phase 9D.3: End-to-End Acceptance Test Suite');
  console.log('================================================================\n');

  AngelOneSessionStore.enableMockStoreForTesting(true);
  ServerRiskStore.clearBufferedEventsForTesting();

  const userId = 'user_p9d3_e2e_trader';
  const angelAccountId = DEFAULT_ANGELONE_ACCOUNT_ID; // 'acc_mt_angelone_default'
  const zerodhaAccountId = DEFAULT_ACCOUNT_ID; // 'acc_mt_zerodha_default'
  const testApiKey = 'P9D3_ANGEL_API_KEY_555';

  // --------------------------------------------------------------------------
  // TEST 1: Consistent Account ID Resolution Across All Subsystems
  // --------------------------------------------------------------------------
  console.log('[Test 1] Consistent Resolution of acc_mt_angelone_default');
  {
    const adapter = liveAngelOneAdapter;
    adapter.setFetchHandler(async (input: any) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/loginByPassword')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            status: true,
            data: { jwtToken: 'Bearer mock_jwt_token_p9d3_longer_than_20_chars' },
          }),
        } as any;
      }
      return { ok: false, status: 400, json: async () => ({}) } as any;
    });

    const authRes = await adapter.authenticate(
      userId,
      {
        apiKey: testApiKey,
        clientCode: 'CLIENT_P9D3',
        password: 'PassWord123',
        totp: '123456',
      },
      { connectionId: angelAccountId }
    );
    assert.equal(authRes.success, true, 'Auth must succeed for angelAccountId');

    const loadedSession = await AngelOneSessionStore.loadSession(userId, { connectionId: angelAccountId });
    assert.ok(loadedSession, 'Session must exist for acc_mt_angelone_default');
    assert.equal(loadedSession?.authState, 'AUTHENTICATED', 'Session is AUTHENTICATED');

    const loadedKey = await AngelOneSessionStore.loadApiKey(userId, angelAccountId);
    assert.equal(loadedKey, testApiKey, 'Stored API key matches test key');

    const connStatus = await adapter.getConnectionStatus(userId, { connectionId: angelAccountId });
    assert.equal(connStatus.status, 'AUTHENTICATED');
    assert.equal(connStatus.authenticated, true);

    console.log('  ✓ PASSED: acc_mt_angelone_default resolves consistently across session, key, and status');
  }

  // --------------------------------------------------------------------------
  // TEST 2: Exclusive P&L Sourcing & Zero Fallback Leakage
  // --------------------------------------------------------------------------
  console.log('\n[Test 2] Exclusive Angel One P&L Sourcing & Zero Fallback Leakage');
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
                netqty: '100',
                avgprice: '150.0',
                ltp: '130.0',
                pnl: '-2000.0',
                realised: '0.0',
                unrealised: '-2000.0',
              },
            ],
          }),
        } as any;
      }
      return { ok: false, status: 400, json: async () => ({}) } as any;
    });

    const rawPositions = await adapter.getPositions(userId, { connectionId: angelAccountId });
    assert.equal(rawPositions.length, 1);
    assert.equal(rawPositions[0].pnl, -2000.0);

    const config = await ServerRiskStore.getConfig(userId, angelAccountId);
    const pnlCalc = PnlEngine.calculate(
      [
        {
          exchange: 'NFO',
          tradingsymbol: 'NIFTY26OCT25000CE',
          product: 'CARRYFORWARD',
          quantity: 100,
          averagePrice: 150.0,
          lastPrice: 130.0,
          pnl: -2000.0,
          realised: 0,
          unrealised: -2000.0,
          segment: 'NFO',
          instrumentType: 'OPTIDX',
          totalPnl: -2000.0,
          realisedPnl: 0,
          unrealisedPnl: -2000.0,
          dayBuyQuantity: 100,
          dayBuyValue: 15000,
          daySellQuantity: 0,
          daySellValue: 0,
          instrumentToken: 150001,
          isFno: true,
          dataSource: 'ANGELONE_LIVE',
        },
      ],
      config
    );

    const evalResult = await ServerRiskStore.evaluatePnlResult(userId, pnlCalc, new Date(), config, angelAccountId);
    assert.equal(evalResult.session.currentPnl, -2000.0);
    assert.equal(evalResult.session.lossLimit, 10000);
    assert.equal(evalResult.session.state, 'ALLOW');

    // Test disconnection / error state: Must return DISCONNECTED without returning mock or Zerodha positions
    adapter.setFetchHandler(async () => ({
      ok: false,
      status: 503,
      json: async () => ({ status: false, message: 'Service Unavailable' }),
    }) as any);

    try {
      await adapter.getPositions(userId, { connectionId: angelAccountId });
      assert.fail('Should throw error on upstream 503');
    } catch (err: any) {
      assert.ok(err.message.includes('503') || err.message.includes('getPosition'), 'Fails closed on error');
    }

    console.log('  ✓ PASSED: P&L is strictly sourced from Angel One; failure fails closed without mock leakage');
  }

  // --------------------------------------------------------------------------
  // TEST 3: Authoritative Risk Config Parameters (₹10,000 Limit, 70/90 Thresholds, ENFORCE)
  // --------------------------------------------------------------------------
  console.log('\n[Test 3] Authoritative Risk Config Parameters');
  {
    const angelConfig = await ServerRiskStore.getConfig(userId, angelAccountId);
    assert.equal(angelConfig.dailyLossLimit, 10000, 'Daily loss limit is ₹10,000');
    assert.equal(angelConfig.warningThreshold1, 70, 'Warning threshold 1 is 70%');
    assert.equal(angelConfig.warningThreshold2, 90, 'Warning threshold 2 is 90%');
    assert.equal(angelConfig.executionMode, 'ENFORCE', 'Execution mode is ENFORCE');
    assert.equal(angelConfig.broker, 'angelone', 'Broker is angelone');

    console.log('  ✓ PASSED: Persisted ₹10,000 daily loss limit, 70%/90% thresholds, and ENFORCE mode verified');
  }

  // --------------------------------------------------------------------------
  // TEST 4: Account Switching Isolation (Zero Cross-Account Stale Data Leakage)
  // --------------------------------------------------------------------------
  console.log('\n[Test 4] Account Switching Isolation');
  {
    const zerodhaConfig = await ServerRiskStore.getConfig(userId, zerodhaAccountId);
    const angelConfig = await ServerRiskStore.getConfig(userId, angelAccountId);

    assert.equal(zerodhaConfig.broker, 'zerodha', 'Zerodha account has Zerodha broker');
    assert.equal(angelConfig.broker, 'angelone', 'Angel One account has Angel One broker');
    assert.notEqual(zerodhaConfig.accountId, angelConfig.accountId, 'Account IDs are strictly isolated');

    // Retrieve sessions for both accounts
    const zerodhaSession = await ServerRiskStore.getSession(userId, undefined, zerodhaAccountId);
    const angelSession = await ServerRiskStore.getSession(userId, undefined, angelAccountId);

    assert.ok(zerodhaSession, 'Zerodha session exists');
    assert.ok(angelSession, 'Angel session exists');

    console.log('  ✓ PASSED: Account switching maintains strict data isolation between Zerodha and Angel One');
  }

  // --------------------------------------------------------------------------
  // TEST 5: Active Lock Preservation & Fail-Closed Security
  // --------------------------------------------------------------------------
  console.log('\n[Test 5] Active Lock Preservation & Fail-Closed Security');
  {
    const config = await ServerRiskStore.getConfig(userId, angelAccountId);
    const breachPnl = PnlEngine.calculate(
      [
        {
          exchange: 'NFO',
          tradingsymbol: 'NIFTY26OCT25000CE',
          product: 'CARRYFORWARD',
          quantity: 200,
          averagePrice: 150.0,
          lastPrice: 80.0,
          pnl: -14000.0,
          realised: 0,
          unrealised: -14000.0,
          segment: 'NFO',
          instrumentType: 'OPTIDX',
          totalPnl: -14000.0,
          realisedPnl: 0,
          unrealisedPnl: -14000.0,
          dayBuyQuantity: 200,
          dayBuyValue: 30000,
          daySellQuantity: 0,
          daySellValue: 0,
          instrumentToken: 150001,
          isFno: true,
          dataSource: 'ANGELONE_LIVE',
        },
      ],
      config
    );

    // Evaluate loss breach (-₹14,000 >= ₹10,000 limit) -> Establishes LOCKED circuit breaker
    const evalBreach = await ServerRiskStore.evaluatePnlResult(userId, breachPnl, new Date(), config, angelAccountId);
    assert.equal(evalBreach.session.state, 'LOCKED', 'Firewall engages LOCKED state on breach');
    assert.equal(evalBreach.session.isBreached, true, 'isBreached is true');

    // Simulate API key deletion or broker failure
    await AngelOneSessionStore.deleteApiKey(userId, angelAccountId);
    const connStatus = await liveAngelOneAdapter.getConnectionStatus(userId, { connectionId: angelAccountId });
    assert.equal(connStatus.status, 'CONFIGURATION_ERROR', 'getConnectionStatus reports CONFIGURATION_ERROR on missing key');

    // Re-query risk session: Lock MUST NOT be cleared or bypassed by broker failure!
    const activeLockSession = await ServerRiskStore.getSession(userId, undefined, angelAccountId);
    assert.equal(activeLockSession?.state, 'LOCKED', 'Active lock MUST persist despite missing API key / broker error');
    assert.equal(activeLockSession?.isBreached, true, 'isBreached remains true');

    console.log('  ✓ PASSED: Active circuit breaker lock is strictly preserved across broker failure / missing API key');
  }

  console.log('\n================================================================');
  console.log('ALL PHASE 9D.3 E2E ACCEPTANCE TESTS PASSED (5/5)');
  console.log('================================================================\n');
}

runPhase9d3E2eAcceptanceSuite().catch((err) => {
  console.error('Phase 9D.3 E2E Acceptance Suite Failed:', err);
  process.exit(1);
});
