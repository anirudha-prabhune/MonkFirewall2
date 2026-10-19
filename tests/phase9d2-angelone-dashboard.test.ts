import { strict as assert } from 'assert';
import { ServerRiskStore, DEFAULT_ACCOUNT_ID, DEFAULT_ANGELONE_ACCOUNT_ID } from '../server/risk/store';
import { RiskEngine } from '../server/risk/engine';
import { DEFAULT_ANGELONE_RISK_CONFIG, DEFAULT_RISK_CONFIG } from '../src/types/risk';

console.log('================================================================');
console.log('MONKTRADES PHASE 9D.2: ANGEL ONE DASHBOARD DATA-BINDING & RISK SUITE');
console.log('₹10,000 Limit, ENFORCE Policy, Session Binding & Account Switching');
console.log('================================================================');

async function runPhase9d2Tests() {
  const userId = 'user_angelone_dashboard_test';
  const angelAccountId = DEFAULT_ANGELONE_ACCOUNT_ID;
  const zerodhaAccountId = DEFAULT_ACCOUNT_ID;

  ServerRiskStore.reset();

  // ------------------------------------------------------------------
  // TEST 1: Authoritative Account-Scoped Angel One Configuration
  // ------------------------------------------------------------------
  console.log('\nTEST 1: Authoritative Angel One Risk Configuration & Parameters');
  {
    ServerRiskStore.reset();

    const angelConfig = await ServerRiskStore.getConfig(userId, angelAccountId);
    assert.equal(angelConfig.accountId, angelAccountId, 'Config accountId must match acc_mt_angelone_default');
    assert.equal(angelConfig.broker, 'angelone', 'Config broker must be angelone');
    assert.equal(angelConfig.dailyLossLimit, 10000, 'Daily loss limit must be exactly ₹10,000');
    assert.equal(angelConfig.warningThreshold1, 70, 'Warning threshold 1 must be 70%');
    assert.equal(angelConfig.warningThreshold2, 90, 'Warning threshold 2 must be 90%');
    assert.equal(angelConfig.lockDurationMinutes, 720, 'Lock duration must be 720 minutes');
    assert.equal(angelConfig.executionMode, 'ENFORCE', 'Execution mode must be ENFORCE');
    assert.equal(angelConfig.enabled, true, 'Risk firewall must be enabled');

    console.log('  PASSED: Angel One configuration strictly verified at ₹10,000 limit in ENFORCE mode.');
  }

  // ------------------------------------------------------------------
  // TEST 2: Multi-Account Isolation Between Angel One & Zerodha
  // ------------------------------------------------------------------
  console.log('\nTEST 2: Independent Configuration Between Angel One & Zerodha');
  {
    ServerRiskStore.reset();

    // Custom save for Zerodha with ₹25,000 limit
    await ServerRiskStore.saveConfig(
      userId,
      {
        ...DEFAULT_RISK_CONFIG,
        dailyLossLimit: 25000,
        warningThreshold1: 60,
        warningThreshold2: 80,
      },
      zerodhaAccountId
    );

    const zerodhaConfig = await ServerRiskStore.getConfig(userId, zerodhaAccountId);
    const angelConfig = await ServerRiskStore.getConfig(userId, angelAccountId);

    assert.equal(zerodhaConfig.dailyLossLimit, 25000, 'Zerodha limit should be ₹25,000');
    assert.equal(angelConfig.dailyLossLimit, 10000, 'Angel One limit must remain independent at ₹10,000');
    assert.equal(zerodhaConfig.broker, 'zerodha');
    assert.equal(angelConfig.broker, 'angelone');

    console.log('  PASSED: Account-scoped configurations remain completely isolated.');
  }

  // ------------------------------------------------------------------
  // TEST 3: Angel One Live P&L Evaluation, Buffer, and Warning State
  // ------------------------------------------------------------------
  console.log('\nTEST 3: Live P&L Evaluation, Buffer & Warning Threshold Binding');
  {
    ServerRiskStore.reset();
    const angelConfig = await ServerRiskStore.getConfig(userId, angelAccountId);

    // Evaluate loss of ₹7,500 (75% utilized -> crosses 70% threshold)
    const pnlWarning: any = {
      grossTradingPnl: -7500,
      realisedPnl: -5000,
      unrealisedPnl: -2500,
      netPnl: -7500,
      timestamp: '2026-10-16T10:15:00.000Z',
      tradingDate: '2026-10-16',
      broker: 'angelone',
      accountId: angelAccountId,
      status: 'OK',
    };

    const evalResult = await ServerRiskStore.evaluatePnlResult(
      userId,
      pnlWarning,
      new Date(pnlWarning.timestamp),
      angelConfig,
      angelAccountId
    );

    assert.equal(evalResult.session.state, 'WARNING', 'State should be WARNING when loss is 75% of limit');
    assert.equal(evalResult.session.currentPnl, -7500);
    assert.equal(evalResult.lossUtilizedPercent, 75, 'Utilization should be 75%');

    // Buffer calculation check
    const lossAmount = Math.max(0, -pnlWarning.grossTradingPnl);
    const remainingBuffer = Math.max(0, angelConfig.dailyLossLimit - lossAmount);
    assert.equal(remainingBuffer, 2500, 'Remaining buffer should be ₹2,500');

    console.log('  PASSED: Angel One P&L correctly triggers WARNING with accurate loss buffer.');
  }

  // ------------------------------------------------------------------
  // TEST 4: Angel One Circuit Breaker Breach & 720m Lock Enforcement
  // ------------------------------------------------------------------
  console.log('\nTEST 4: Loss Limit Breach Triggers 720m Lock in ENFORCE Mode');
  {
    ServerRiskStore.reset();
    const angelConfig = await ServerRiskStore.getConfig(userId, angelAccountId);

    // Evaluate breach loss of ₹11,000 (exceeds ₹10,000 limit)
    const pnlBreach: any = {
      grossTradingPnl: -11000,
      realisedPnl: -11000,
      unrealisedPnl: 0,
      netPnl: -11000,
      timestamp: '2026-10-16T11:00:00.000Z',
      tradingDate: '2026-10-16',
      broker: 'angelone',
      accountId: angelAccountId,
      status: 'OK',
    };

    const evalResult = await ServerRiskStore.evaluatePnlResult(
      userId,
      pnlBreach,
      new Date(pnlBreach.timestamp),
      angelConfig,
      angelAccountId
    );

    assert.equal(evalResult.session.state, 'LOCKED', 'State must transition to LOCKED upon breach');
    assert.equal(evalResult.session.executionMode, 'ENFORCE');
    assert.equal(evalResult.session.isBreached, true);
    assert.ok(evalResult.session.lockUntil, 'lockUntil must be set');

    // Verify 720 minutes (12 hours) duration
    const lockStart = new Date(pnlBreach.timestamp).getTime();
    const lockExpiry = new Date(evalResult.session.lockUntil!).getTime();
    const durationMinutes = Math.round((lockExpiry - lockStart) / (1000 * 60));
    assert.equal(durationMinutes, 720, 'Lock duration must be exactly 720 minutes');

    // Verify Zerodha session is unaffected
    const zerodhaSession = await ServerRiskStore.getSession(userId, '2026-10-16', zerodhaAccountId);
    assert.notEqual(zerodhaSession?.state, 'LOCKED', 'Zerodha must NOT be locked when Angel One breaches');

    console.log('  PASSED: Angel One breach enforces 720m lock without affecting Zerodha.');
  }

  // ------------------------------------------------------------------
  // TEST 5: Account Switching Consistency
  // ------------------------------------------------------------------
  console.log('\nTEST 5: Account Switching Consistency & Independent Persistence');
  {
    // Retrieve authoritative sessions for both accounts
    const angelSession = await ServerRiskStore.getSession(userId, '2026-10-16', angelAccountId);
    const zerodhaSession = await ServerRiskStore.getSession(userId, '2026-10-16', zerodhaAccountId);

    assert.equal(angelSession.state, 'LOCKED', 'Angel One preserves its LOCKED state');
    assert.equal(angelSession.accountId, angelAccountId);

    assert.notEqual(zerodhaSession?.state, 'LOCKED', 'Zerodha preserves independent state');

    console.log('  PASSED: Independent state confirmed across account switches.');
  }

  // ------------------------------------------------------------------
  // TEST 6: Fail-Closed Protection Without Mock Substitution
  // ------------------------------------------------------------------
  console.log('\nTEST 6: Fail-Closed Behavior on Corrupted Data');
  {
    const angelConfig = await ServerRiskStore.getConfig(userId, angelAccountId);

    // Missing/corrupted grossTradingPnl must throw PnlIntegrityError rather than assuming ₹0
    assert.throws(
      () => {
        RiskEngine.evaluate({
          config: angelConfig,
          pnlResult: {
            grossTradingPnl: NaN as any,
          } as any,
        });
      },
      /PnlIntegrityError/,
      'Must reject NaN or missing grossTradingPnl with PnlIntegrityError'
    );

    console.log('  PASSED: Corrupt P&L fails closed without substituting mock or zero data.');
  }

  // ------------------------------------------------------------------
  // TEST 7: Angel One F&O Normalization & Authoritative Master Recognition
  // ------------------------------------------------------------------
  console.log('\nTEST 7: Angel One F&O Position Normalization & Master Recognition');
  {
    const { normalizePositions } = await import('../server/brokers/normalize');
    const { MOCK_INSTRUMENT_MAP } = await import('../server/instruments/master');
    const rawAngelPositions = [
      {
        exchange: 'NFO',
        tradingsymbol: 'NIFTY26OCT24000CE',
        product: 'CARRYFORWARD',
        quantity: 50,
        average_price: 150.0,
        last_price: 165.0,
        pnl: 750.0,
        realised: 0.0,
        unrealised: 750.0,
        day_buy_quantity: 50,
        day_buy_value: 7500.0,
        day_sell_quantity: 0,
        day_sell_value: 0.0,
        instrument_token: 999001,
        multiplier: 50,
      },
      {
        exchange: 'NFO',
        tradingsymbol: 'BANKNIFTY26OCT45000CE',
        product: 'CARRYFORWARD',
        quantity: 30,
        average_price: 250.0,
        last_price: 310.0,
        pnl: 1800.0,
        realised: 0.0,
        unrealised: 1800.0,
        day_buy_quantity: 30,
        day_buy_value: 7500.0,
        day_sell_quantity: 0,
        day_sell_value: 0.0,
        instrument_token: 99001,
        multiplier: 15,
      },
    ];

    const normalized = normalizePositions(rawAngelPositions, MOCK_INSTRUMENT_MAP, 'ANGELONE_LIVE');
    assert.equal(normalized.length, 2, 'Should normalize 2 Angel One positions');
    assert.equal(normalized[0].isFno, true, 'NIFTY 24000 CE must be classified as F&O');
    assert.equal(normalized[0].unknownInstrument, false, 'NIFTY 24000 CE must be recognized');
    assert.equal(normalized[0].dataSource, 'ANGELONE_LIVE');

    assert.equal(normalized[1].isFno, true, 'BANKNIFTY 45000 CE must be classified as F&O');
    assert.equal(normalized[1].unknownInstrument, false, 'BANKNIFTY 45000 CE must be recognized');
    assert.equal(normalized[1].dataSource, 'ANGELONE_LIVE');

    const fnoPositions = normalized.filter((p) => p.isFno === true && !p.unknownInstrument);
    assert.equal(fnoPositions.length, 2, 'Both positions must remain in F&O set');

    console.log('  PASSED: Angel One derivative positions recognized as valid F&O with dataSource ANGELONE_LIVE.');
  }

  // ------------------------------------------------------------------
  // TEST 8: AUTHENTICATED Connection Evaluation in F&O P&L Calculation
  // ------------------------------------------------------------------
  console.log('\nTEST 8: Angel One AUTHENTICATED Connection State Sourcing');
  {
    const { PnlEngine } = await import('../server/pnl/engine');
    const { normalizePositions } = await import('../server/brokers/normalize');
    const { MOCK_INSTRUMENT_MAP } = await import('../server/instruments/master');

    const angelConfig = await ServerRiskStore.getConfig(userId, angelAccountId);
    const rawAngelPositions = [
      {
        exchange: 'NFO',
        tradingsymbol: 'NIFTY26OCT24000CE',
        product: 'CARRYFORWARD',
        quantity: 50,
        average_price: 150.0,
        last_price: 165.0,
        pnl: 750.0,
        realised: 0.0,
        unrealised: 750.0,
        day_buy_quantity: 50,
        day_buy_value: 7500.0,
        day_sell_quantity: 0,
        day_sell_value: 0.0,
        instrument_token: 999001,
        multiplier: 1,
      },
    ];

    const normalized = normalizePositions(rawAngelPositions, MOCK_INSTRUMENT_MAP, 'ANGELONE_LIVE');
    const fnoPositions = normalized.filter((p) => p.isFno === true && !p.unknownInstrument);

    const pnlCalc = PnlEngine.calculate(fnoPositions, angelConfig);
    assert.equal(pnlCalc.totalPnl, 750.0, 'Total P&L should be ₹750.0');
    assert.equal(pnlCalc.grossTradingPnl, 750.0, 'Gross Trading P&L should be ₹750.0');
    assert.equal(pnlCalc.fnoPositionCount, 1, 'fnoPositionCount must be 1');

    console.log('  PASSED: Angel One F&O P&L calculated authoritatively from normalized positions.');
  }

  // ------------------------------------------------------------------
  // TEST 9: Prevention of ₹500 or Zerodha Default Fallback for Angel One
  // ------------------------------------------------------------------
  console.log('\nTEST 9: Angel One ₹10,000 Configuration Defense Against ₹500 Fallback');
  {
    const { getRiskConfig } = await import('../src/services/riskConfigService');
    const config = await getRiskConfig('mock-test-user-isolated', angelAccountId);

    assert.equal(config.dailyLossLimit, 10000, 'Angel One config must be ₹10,000, never ₹500');
    assert.equal(config.warningThreshold1, 70, 'Threshold 1 must be 70%');
    assert.equal(config.warningThreshold2, 90, 'Threshold 2 must be 90%');
    assert.equal(config.executionMode, 'ENFORCE', 'Execution mode must be ENFORCE');
    assert.equal(config.broker, 'angelone');

    console.log('  PASSED: Angel One configuration strictly preserves ₹10,000 limit and ENFORCE mode.');
  }

  console.log('\n================================================================');
  console.log('ALL PHASE 9D.2 ANGEL ONE DASHBOARD TESTS PASSED SUCCESSFULLY! (9/9)');
  console.log('================================================================\n');
}

runPhase9d2Tests().catch((err) => {
  console.error('\nTEST FAILURE:', err);
  process.exit(1);
});
