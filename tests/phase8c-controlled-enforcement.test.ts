import { strict as assert } from 'assert';
import { ServerRiskStore, DEFAULT_ACCOUNT_ID, DEFAULT_ANGELONE_ACCOUNT_ID } from '../server/risk/store';
import { PnlEngine } from '../server/pnl/engine';
import { enableMockStoreForTesting, setAdminFirestoreForTesting } from '../server/brokers/zerodha/sessionStore';
import { DEFAULT_RISK_CONFIG, DEFAULT_ANGELONE_RISK_CONFIG } from '../src/types/risk';
import { NormalizedPosition } from '../server/brokers/types';

async function runPhase8CTests() {
  console.log('================================================================');
  console.log('MONKTRADES PHASE 8C: ANGEL ONE CONTROLLED ENFORCEMENT SUITE');
  console.log('Explicit Activation, Fail-Closed Evaluation & Lock Isolation');
  console.log('================================================================');

  enableMockStoreForTesting(true);
  setAdminFirestoreForTesting(null);
  ServerRiskStore.reset();

  const userId = 'user_p8c_test';

  // TEST 1: Default OBSERVE_ONLY & Explicit ENFORCE Activation
  try {
    // 1. Initial default configuration for Angel One is OBSERVE_ONLY
    const initialConfig = await ServerRiskStore.getConfig(userId, DEFAULT_ANGELONE_ACCOUNT_ID);
    assert.equal(initialConfig.executionMode, 'OBSERVE_ONLY', 'Angel One defaults to OBSERVE_ONLY');

    // 2. Explicit authorized account-scoped activation of ENFORCE mode
    const saveRes = await ServerRiskStore.saveConfig(userId, {
      ...DEFAULT_ANGELONE_RISK_CONFIG,
      dailyLossLimit: 10000,
      executionMode: 'ENFORCE',
      accountId: DEFAULT_ANGELONE_ACCOUNT_ID,
      broker: 'angelone',
    }, DEFAULT_ANGELONE_ACCOUNT_ID);

    assert(saveRes.success, 'Explicit saveConfig for ENFORCE mode succeeds');
    const updatedConfig = await ServerRiskStore.getConfig(userId, DEFAULT_ANGELONE_ACCOUNT_ID);
    assert.equal(updatedConfig.executionMode, 'ENFORCE', 'Angel One executionMode updated to ENFORCE');

    // 3. Verify Zerodha remains completely independent
    const zerodhaConfig = await ServerRiskStore.getConfig(userId, DEFAULT_ACCOUNT_ID);
    assert.equal(zerodhaConfig.executionMode, 'ENFORCE');
    assert.equal(zerodhaConfig.dailyLossLimit, DEFAULT_RISK_CONFIG.dailyLossLimit);

    console.log('  ✓ PASSED: Explicit ENFORCE activation for Angel One preserves account isolation and defaults');
  } catch (err) {
    console.error('  ✗ FAILED TEST 1:', err);
    process.exit(1);
  }

  // TEST 2: Active Enforcement Breach -> Account-Scoped LOCKED State
  try {
    const angelConfig = await ServerRiskStore.getConfig(userId, DEFAULT_ANGELONE_ACCOUNT_ID);
    const breachedPositions: NormalizedPosition[] = [
      {
        tradingsymbol: 'BANKNIFTY26OCT50000CE',
        instrumentToken: 99999,
        exchange: 'NFO',
        product: 'NRML',
        segment: 'NFO-OPT',
        instrumentType: 'CE',
        quantity: 50,
        averagePrice: 300,
        lastPrice: 60,
        totalPnl: -12000,
        realisedPnl: 0,
        unrealisedPnl: -12000,
        dayBuyQuantity: 0,
        dayBuyValue: 0,
        daySellQuantity: 0,
        daySellValue: 0,
        isFno: true,
        dataSource: 'ANGELONE_LIVE',
      },
    ];

    const pnlCalc = PnlEngine.calculate(breachedPositions, angelConfig);
    assert.equal(pnlCalc.grossTradingPnl, -12000);

    // Evaluate via ServerRiskStore under ENFORCE mode
    const breachEval = await ServerRiskStore.evaluatePnlResult(userId, pnlCalc, new Date(), angelConfig, DEFAULT_ANGELONE_ACCOUNT_ID);

    assert.equal(breachEval.session.state, 'LOCKED', 'Angel One in ENFORCE mode establishes LOCKED state on breach');
    assert.equal(breachEval.session.isBreached, true);
    assert(breachEval.session.lockedAt !== null, 'lockedAt timestamp recorded');
    assert(breachEval.session.lockUntil !== null, 'lockUntil timestamp recorded');

    // Verify Zerodha session remains ALLOW (Zero Cross-Broker Lock Leakage)
    const zerodhaSession = await ServerRiskStore.getSession(userId, undefined, DEFAULT_ACCOUNT_ID);
    assert.equal(zerodhaSession.state, 'ALLOW', 'Zerodha session unaffected by Angel One lock');

    console.log('  ✓ PASSED: Angel One breach in ENFORCE mode creates circuit breaker lock without Zerodha leakage');
  } catch (err) {
    console.error('  ✗ FAILED TEST 2:', err);
    process.exit(1);
  }

  // TEST 3: Lock Immutability & Reconnection Fail-Closed Protection
  try {
    // Attempt to modify Daily Loss Limit while LOCKED -> Must be rejected
    const mutateRes = await ServerRiskStore.saveConfig(userId, {
      ...DEFAULT_ANGELONE_RISK_CONFIG,
      dailyLossLimit: 25000, // Attempting to raise limit during active lock
      executionMode: 'ENFORCE',
      accountId: DEFAULT_ANGELONE_ACCOUNT_ID,
    }, DEFAULT_ANGELONE_ACCOUNT_ID);

    assert.equal(mutateRes.success, false, 'RiskConfig mutation rejected during active lock');
    assert.equal(mutateRes.code, 'RISK_CONFIG_LOCKED');

    // Verify limit remains unchanged
    const currentCfg = await ServerRiskStore.getConfig(userId, DEFAULT_ANGELONE_ACCOUNT_ID);
    assert.equal(currentCfg.dailyLossLimit, 10000, 'Daily loss limit preserved at ₹10,000');

    // Verify getSession preserves LOCKED state on disconnection / reconnection
    const reconnectedSession = await ServerRiskStore.getSession(userId, undefined, DEFAULT_ANGELONE_ACCOUNT_ID);
    assert.equal(reconnectedSession.state, 'LOCKED', 'Reconnection preserves active LOCKED state');

    console.log('  ✓ PASSED: Lock immutability prevents limit edits during lock; reconnection preserves LOCKED state');
  } catch (err) {
    console.error('  ✗ FAILED TEST 3:', err);
    process.exit(1);
  }

  // TEST 4: Authorized Reset Flow Clears Lock
  try {
    await ServerRiskStore.resetSession(userId, DEFAULT_ANGELONE_ACCOUNT_ID);

    const postResetSession = await ServerRiskStore.getSession(userId, undefined, DEFAULT_ANGELONE_ACCOUNT_ID);
    assert.equal(postResetSession.state, 'ALLOW', 'Authorized session reset clears lock state');

    // After reset, config modification is allowed
    const postResetSave = await ServerRiskStore.saveConfig(userId, {
      ...DEFAULT_ANGELONE_RISK_CONFIG,
      dailyLossLimit: 20000,
      executionMode: 'ENFORCE',
      accountId: DEFAULT_ANGELONE_ACCOUNT_ID,
    }, DEFAULT_ANGELONE_ACCOUNT_ID);

    assert(postResetSave.success, 'Configuration edit succeeds post authorized session reset');
    const updatedCfg = await ServerRiskStore.getConfig(userId, DEFAULT_ANGELONE_ACCOUNT_ID);
    assert.equal(updatedCfg.dailyLossLimit, 20000);

    console.log('  ✓ PASSED: Authorized reset unlocks configuration and restores ALLOW state');
  } catch (err) {
    console.error('  ✗ FAILED TEST 4:', err);
    process.exit(1);
  }

  console.log('================================================================');
  console.log('ALL PHASE 8C CONTROLLED ENFORCEMENT TESTS PASSED SUCCESSFULLY!');
  console.log('================================================================');
  process.exit(0);
}

runPhase8CTests().catch((err) => {
  console.error('Phase 8C test suite failed:', err);
  process.exit(1);
});
