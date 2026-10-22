import { strict as assert } from 'assert';
import { liveAngelOneAdapter } from '../server/brokers/angelone/liveAdapter';
import { liveZerodhaAdapter } from '../server/brokers/zerodha/liveAdapter';
import { AngelOneSessionStore } from '../server/brokers/angelone/sessionStore';
import { ServerRiskStore, DEFAULT_ACCOUNT_ID, DEFAULT_ANGELONE_ACCOUNT_ID } from '../server/risk/store';
import { PnlEngine } from '../server/pnl/engine';
import { RiskEngine } from '../server/risk/engine';

import { normalizePositions } from '../server/brokers/normalize';

async function runStage3PnlDashboardTests() {
  console.log('================================================================');
  console.log('Angel One Stage 3: P&L, Risk & Dashboard Integration Suite');
  console.log('================================================================\n');

  AngelOneSessionStore.enableMockStoreForTesting(true);

  const userId = 'trader_stage3_test_user';
  const zerodhaAccId = DEFAULT_ACCOUNT_ID; // 'acc_mt_zerodha_default'
  const angelAccId = DEFAULT_ANGELONE_ACCOUNT_ID; // 'acc_mt_angelone_default'
  const testApiKey = 'STAGE3_API_KEY_VALID_777';
  const testClientCode = 'S3CLIENT777';
  const testToken = 'mock_valid_jwt_token_for_stage3_tests_9999999999';

  let currentAngelFetchResponse: { status: number; ok: boolean; body: any } | null = null;

  const mockFetch = async (url: string, options: any) => {
    if (!currentAngelFetchResponse) {
      throw new Error('No mock response configured for Angel One');
    }
    return {
      ok: currentAngelFetchResponse.ok,
      status: currentAngelFetchResponse.status,
      json: async () => currentAngelFetchResponse!.body,
    } as any;
  };

  liveAngelOneAdapter.setFetchHandler(mockFetch as any);

  async function resetAndAuthenticateAngelOne() {
    liveAngelOneAdapter.clearUserErrorState(userId, angelAccId);
    await AngelOneSessionStore.saveApiKey(userId, testApiKey, angelAccId);
    await AngelOneSessionStore.saveSession(userId, testToken, {
      clientCode: testClientCode,
      connectionId: angelAccId,
    });
  }

  // --------------------------------------------------------------------------
  // Test 1: Sourcing Positions & Capital Exclusively From Selected Angel One Account
  // --------------------------------------------------------------------------
  console.log('[Test 1] Sourcing Exclusively From Selected Angel One Account...');
  {
    await resetAndAuthenticateAngelOne();

    currentAngelFetchResponse = {
      status: 200,
      ok: true,
      body: {
        status: true,
        message: 'SUCCESS',
        data: [
          {
            exchange: 'NFO',
            tradingsymbol: 'NIFTY24OCT25000CE',
            symboltoken: '35001',
            producttype: 'CARRYFORWARD',
            netqty: '50',
            avgprice: '120.00',
            ltp: '150.00',
            pnl: '1500.00',
          },
        ],
      },
    };

    const positions = await liveAngelOneAdapter.getPositions(userId, { connectionId: angelAccId });
    assert.equal(positions.length, 1);
    assert.equal(positions[0].tradingsymbol, 'NIFTY24OCT25000CE');
    assert.equal(positions[0].quantity, 50);

    const instrumentMap = new Map<number, any>([
      [
        35001,
        {
          instrumentToken: 35001,
          tradingSymbol: 'NIFTY24OCT25000CE',
          exchange: 'NFO',
          segment: 'NFO-OPT',
          instrumentType: 'OPT',
          lotSize: 25,
          tickSize: 0.05,
          expiry: '2026-10-24',
        },
      ],
    ]);
    const normalized = normalizePositions(positions, instrumentMap, 'ANGELONE_LIVE');
    const fnoPositions = normalized.filter((p) => p.isFno === true);
    const pnlCalc = PnlEngine.calculate(fnoPositions as any);
    assert.equal(pnlCalc.grossTradingPnl, 1500);

    const evalResult = await ServerRiskStore.evaluatePnlResult(userId, pnlCalc, new Date(), undefined, angelAccId);
    assert.equal(evalResult.session.userId, userId);
    assert.equal(evalResult.session.state, 'ALLOW');

    console.log('  ✓ PASSED: Angel One account positions & P&L are sourced exclusively from specified account.');
  }

  // --------------------------------------------------------------------------
  // Test 2: Zero Fallback to Zerodha or Mock Data When Angel One Disconnected
  // --------------------------------------------------------------------------
  console.log('\n[Test 2] Zero Fallback to Zerodha or Mock Data When Angel One Disconnected...');
  {
    // Simulate Angel One token expiry / disconnected state
    await AngelOneSessionStore.invalidateSession(userId, undefined, angelAccId);

    const connStatus = await liveAngelOneAdapter.getConnectionStatus(userId, { connectionId: angelAccId });
    assert.equal(connStatus.status, 'AUTHENTICATION_REQUIRED');

    // Capital query for Angel One returns AUTHENTICATION_REQUIRED without Zerodha fallback
    const capital = await liveAngelOneAdapter.getCapital(userId, { connectionId: angelAccId });
    assert.equal(capital.broker, 'angelone');
    assert.equal(capital.connectionStatus, 'AUTHENTICATION_REQUIRED');
    assert.equal(capital.isStale, true);
    assert.equal(capital.netBalance, null);

    console.log('  ✓ PASSED: Disconnected Angel One account safely reports AUTHENTICATION_REQUIRED without falling back to Zerodha.');
  }

  // --------------------------------------------------------------------------
  // Test 3: Account & Broker Lock Isolation (Zerodha vs Angel One)
  // --------------------------------------------------------------------------
  console.log('\n[Test 3] Account & Broker Lock Isolation (Zerodha vs Angel One)...');
  {
    await resetAndAuthenticateAngelOne();

    // Trigger daily loss limit breach on Angel One account
    const breachPnl = {
      grossTradingPnl: -10000,
      realisedPnl: -10000,
      unrealisedPnl: 0,
      dailyRealisedPnl: -10000,
      dailyUnrealisedPnl: 0,
      totalPnl: -10000,
      tradingDate: '2026-10-20',
      calculatedAt: new Date().toISOString(),
      positionCount: 1,
      fnoPositionCount: 1,
      isFnoOnly: true,
      executionMode: 'ENFORCE' as const,
    };

    const angelConfig = {
      dailyLossLimit: 5000,
      warningThreshold1: 2500,
      warningThreshold2: 4000,
      lockDurationMinutes: 60,
      lockDurationType: 'FIXED' as const,
      includeRealisedPnl: true,
      includeUnrealisedPnl: true,
      enabled: true,
      broker: 'angelone' as const,
      accountId: angelAccId,
    };

    const angelEval = await ServerRiskStore.evaluatePnlResult(userId, breachPnl as any, new Date(), angelConfig, angelAccId);
    assert.equal(angelEval.session.state, 'LOCKED');
    assert.equal(angelEval.session.isBreached, true);

    // Verify Zerodha account remains ALLOW and UNLOCKED
    const zerodhaSession = await ServerRiskStore.getSession(userId, undefined, zerodhaAccId);
    assert.equal(zerodhaSession.state, 'ALLOW', 'Zerodha account MUST NOT inherit Angel One loss lock');
    assert.equal(zerodhaSession.isBreached, false);

    console.log('  ✓ PASSED: Risk locks are isolated per broker account without cross-broker leakage.');
  }

  // --------------------------------------------------------------------------
  // Test 4: Active Lock Preservation During Disconnect & Missing Data
  // --------------------------------------------------------------------------
  console.log('\n[Test 4] Active Lock Preservation During Disconnect & Missing Data...');
  {
    // Angel One account is currently LOCKED from Test 3. Simulate API failure / disconnection.
    currentAngelFetchResponse = {
      status: 403,
      ok: false,
      body: { message: 'HTTP 403', errorcode: '' },
    };

    try {
      await liveAngelOneAdapter.getPositions(userId, { connectionId: angelAccId });
    } catch {}

    // Evaluate risk with empty positions during disconnect
    const emptyPnl = {
      grossTradingPnl: 0,
      realisedPnl: 0,
      unrealisedPnl: 0,
      dailyRealisedPnl: 0,
      dailyUnrealisedPnl: 0,
      totalPnl: 0,
      tradingDate: '2026-10-20',
      calculatedAt: new Date().toISOString(),
      positionCount: 0,
      fnoPositionCount: 0,
      isFnoOnly: true,
      executionMode: 'ENFORCE' as const,
    };

    const angelConfig = {
      dailyLossLimit: 5000,
      warningThreshold1: 2500,
      warningThreshold2: 4000,
      lockDurationMinutes: 60,
      lockDurationType: 'FIXED' as const,
      includeRealisedPnl: true,
      includeUnrealisedPnl: true,
      enabled: true,
      broker: 'angelone' as const,
      accountId: angelAccId,
    };

    const evalDuringDisconnect = await ServerRiskStore.evaluatePnlResult(userId, emptyPnl as any, new Date(), angelConfig, angelAccId);
    assert.equal(evalDuringDisconnect.session.state, 'LOCKED', 'Active loss lock MUST be strictly preserved during disconnect');
    assert.equal(evalDuringDisconnect.session.isBreached, true);

    console.log('  ✓ PASSED: Active loss lock is strictly preserved during endpoint failure and disconnection.');
  }

  // --------------------------------------------------------------------------
  // Test 5: Zerodha Non-Regression Verification
  // --------------------------------------------------------------------------
  console.log('\n[Test 5] Zerodha Non-Regression Verification...');
  {
    // Verify Zerodha live adapter connection status and capital remain unaffected
    const zerodhaStatus = await liveZerodhaAdapter.getConnectionStatus(userId);
    assert.ok(zerodhaStatus, 'Zerodha adapter connection status must function normally');
    assert.equal(zerodhaStatus.broker, 'zerodha');

    const zerodhaCapital = await liveZerodhaAdapter.getCapital(userId);
    assert.ok(zerodhaCapital, 'Zerodha capital fetch must return valid object');
    assert.equal(zerodhaCapital.broker, 'zerodha');

    console.log('  ✓ PASSED: Zerodha broker implementation and behavior remain completely unchanged.');
  }

  console.log('\n================================================================');
  console.log('ALL STAGE 3 P&L & DASHBOARD INTEGRATION TESTS PASSED (5/5)');
  console.log('================================================================\n');
}

runStage3PnlDashboardTests().catch((err) => {
  console.error('\nStage 3 Test Suite Failed:', err);
  process.exit(1);
});
