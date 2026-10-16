import { strict as assert } from 'assert';
import { ServerRiskStore, DEFAULT_ACCOUNT_ID, DEFAULT_ANGELONE_ACCOUNT_ID } from '../server/risk/store';
import { PnlEngine } from '../server/pnl/engine';
import { enableMockStoreForTesting, setAdminFirestoreForTesting } from '../server/brokers/zerodha/sessionStore';
import { DEFAULT_RISK_CONFIG } from '../src/types/risk';
import { NormalizedPosition } from '../server/brokers/types';

async function runPhase8ATests() {
  console.log('================================================================');
  console.log('MONKTRADES PHASE 8A: ANGEL ONE LIVE RISK INTEGRATION SUITE');
  console.log('Account-Scoped Evaluation, Persistence, OBSERVE_ONLY & Isolation');
  console.log('================================================================');

  enableMockStoreForTesting(true);
  setAdminFirestoreForTesting(null);
  ServerRiskStore.reset();

  const userId = 'user_p8a_test';

  // TEST 1: Independent Risk Configuration Setup for Angel One
  try {
    await ServerRiskStore.saveConfig(userId, {
      ...DEFAULT_RISK_CONFIG,
      dailyLossLimit: 8000,
      warningThreshold1: 40,
      warningThreshold2: 80,
      executionMode: 'OBSERVE_ONLY',
      accountId: DEFAULT_ANGELONE_ACCOUNT_ID,
      broker: 'angelone',
    }, DEFAULT_ANGELONE_ACCOUNT_ID);

    await ServerRiskStore.saveConfig(userId, {
      ...DEFAULT_RISK_CONFIG,
      dailyLossLimit: 15000,
      executionMode: 'ENFORCE',
      accountId: DEFAULT_ACCOUNT_ID,
      broker: 'zerodha',
    }, DEFAULT_ACCOUNT_ID);

    const cfgAngel = await ServerRiskStore.getConfig(userId, DEFAULT_ANGELONE_ACCOUNT_ID);
    const cfgZerodha = await ServerRiskStore.getConfig(userId, DEFAULT_ACCOUNT_ID);

    assert.equal(cfgAngel.dailyLossLimit, 8000);
    assert.equal(cfgAngel.executionMode, 'OBSERVE_ONLY', 'Angel One must be OBSERVE_ONLY');
    assert.equal(cfgZerodha.dailyLossLimit, 15000);
    assert.equal(cfgZerodha.executionMode, 'ENFORCE');

    console.log('  ✓ PASSED: Angel One and Zerodha maintain independent account-scoped risk configurations');
  } catch (err) {
    console.error('  ✗ FAILED TEST 1:', err);
    process.exit(1);
  }

  // TEST 2: Independent P&L Calculation & Breach Evaluation for Angel One (OBSERVE_ONLY)
  try {
    const angelPositions: NormalizedPosition[] = [
      {
        tradingsymbol: 'NIFTY26OCT25000CE',
        instrumentToken: 12345,
        exchange: 'NFO',
        product: 'NRML',
        segment: 'NFO-OPT',
        instrumentType: 'CE',
        quantity: 75,
        averagePrice: 100,
        lastPrice: 50,
        totalPnl: -3750,
        realisedPnl: 0,
        unrealisedPnl: -3750,
        dayBuyQuantity: 0,
        dayBuyValue: 0,
        daySellQuantity: 0,
        daySellValue: 0,
        isFno: true,
        dataSource: 'ANGELONE_LIVE',
      },
    ];

    const angelConfig = await ServerRiskStore.getConfig(userId, DEFAULT_ANGELONE_ACCOUNT_ID);
    const pnlCalc = PnlEngine.calculate(angelPositions, angelConfig);

    assert.equal(pnlCalc.grossTradingPnl, -3750);

    // Evaluate via ServerRiskStore for Angel One account
    const evalResult = await ServerRiskStore.evaluatePnlResult(userId, pnlCalc, new Date(), angelConfig, DEFAULT_ANGELONE_ACCOUNT_ID);

    assert.equal(evalResult.session.state, 'WARNING', 'P&L of -3750 breaches 40% warning threshold (3200) but below loss limit');
    assert.equal(evalResult.session.isBreached, false);
    assert.equal(evalResult.lossUtilizedPercent, 46.875);

    // Push loss further to trigger breach (-9000 <= -8000) under OBSERVE_ONLY
    const breachedPositions: NormalizedPosition[] = [
      {
        ...angelPositions[0],
        averagePrice: 200,
        lastPrice: 80,
        totalPnl: -9000,
        unrealisedPnl: -9000,
      },
    ];
    const breachPnlCalc = PnlEngine.calculate(breachedPositions, angelConfig);
    const breachEval = await ServerRiskStore.evaluatePnlResult(userId, breachPnlCalc, new Date(), angelConfig, DEFAULT_ANGELONE_ACCOUNT_ID);

    assert.equal(breachEval.session.state, 'WARNING', 'Angel One in OBSERVE_ONLY reflects WARNING state on breach with zero trading locks');
    assert.equal(breachEval.session.isBreached, true);
    assert.equal(breachEval.session.executionMode, 'OBSERVE_ONLY');
    assert.equal(breachEval.session.lockedAt, null);

    console.log('  ✓ PASSED: Independent Angel One risk evaluation, breach detection and persistence in OBSERVE_ONLY mode');
  } catch (err) {
    console.error('  ✗ FAILED TEST 2:', err);
    process.exit(1);
  }

  // TEST 3: Zero Cross-Account Leakage (Zerodha session remains unaffected)
  try {
    const zerodhaSession = await ServerRiskStore.getSession(userId, undefined, DEFAULT_ACCOUNT_ID);
    assert.equal(zerodhaSession.state, 'ALLOW', 'Zerodha default session remains untouched and ALLOW');

    console.log('  ✓ PASSED: Zero cross-account leakage between Angel One and Zerodha risk states');
  } catch (err) {
    console.error('  ✗ FAILED TEST 3:', err);
    process.exit(1);
  }

  console.log('================================================================');
  console.log('ALL PHASE 8A TESTS PASSED SUCCESSFULLY!');
  console.log('================================================================');
  process.exit(0);
}

runPhase8ATests().catch((err) => {
  console.error('Phase 8A test suite failed:', err);
  process.exit(1);
});
