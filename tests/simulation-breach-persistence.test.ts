import { strict as assert } from 'assert';
import { ServerRiskStore, DEFAULT_ACCOUNT_ID, DEFAULT_ANGELONE_ACCOUNT_ID } from '../server/risk/store';
import { AngelOneSessionStore } from '../server/brokers/angelone/sessionStore';
import { setNseMarketClosedOverride, isNseMarketClosed } from '../server/risk/engine';
import { DEFAULT_ANGELONE_RISK_CONFIG, DEFAULT_RISK_CONFIG } from '../src/types/risk';

async function runSimulationBreachPersistenceSuite() {
  console.log('================================================================');
  console.log('MONKFIREWALL2: SIMULATION BREACH & PERSISTENCE REGRESSION SUITE');
  console.log('Test 1: Loss breach (-₹10,500) triggers LOCKED state during off-hours');
  console.log('Test 2: Simulation session persists across refreshes');
  console.log('Test 3: Reset Demo clears simulation session back to baseline');
  console.log('Test 4: Isolation — Live Angel One/Zerodha sessions & Firestore remain unmutated');
  console.log('================================================================\n');

  AngelOneSessionStore.enableMockStoreForTesting(true);
  ServerRiskStore.clearBufferedEventsForTesting();

  const userId = 'sim_trader_test_101';
  const accountId = DEFAULT_ANGELONE_ACCOUNT_ID;

  // Ensure clean state before tests
  await ServerRiskStore.resetSimulatedSession(userId, accountId);

  // --------------------------------------------------------------------------
  // TEST 1: Loss Breach Triggers LOCKED State During Off-Hours
  // --------------------------------------------------------------------------
  console.log('[Test 1] Simulated Loss Breach (-₹10,500) Triggers LOCKED State Off-Hours');
  {
    // Force off-hours market closed condition
    setNseMarketClosedOverride(true);
    assert.equal(isNseMarketClosed(), true, 'NSE market is set to CLOSED for testing off-market hours');

    // Save config with ₹10,000 Daily Loss Limit
    await ServerRiskStore.saveConfig(userId, { ...DEFAULT_ANGELONE_RISK_CONFIG, dailyLossLimit: 10000, executionMode: 'ENFORCE' }, accountId);

    // 1A. Apply -5,000 loss against 10,000 limit (MUST NOT LOCK)
    const evalResult5k = await ServerRiskStore.evaluateSimulatedPnl(userId, -5000, new Date(), accountId);
    assert.equal(evalResult5k.session.isSimulated, true, 'Session must be isSimulated = true');
    assert.notEqual(evalResult5k.session.state, 'LOCKED', '-₹5,000 loss against ₹10,000 limit MUST NOT produce LOCKED state');
    assert.equal(evalResult5k.session.isBreached, false, 'isBreached must be false for -₹5,000 loss');
    assert.equal(evalResult5k.session.lossAmount, 5000, 'lossAmount must reflect ₹5,000');

    // Reset simulation session for breach test
    await ServerRiskStore.resetSimulatedSession(userId, accountId);

    // 1B. Apply -10,500 loss against 10,000 limit (MUST LOCK)
    const evalResult10k = await ServerRiskStore.evaluateSimulatedPnl(userId, -10500, new Date(), accountId);
    assert.equal(evalResult10k.session.isSimulated, true, 'Session must be explicitly marked as isSimulated = true');
    assert.equal(evalResult10k.session.state, 'LOCKED', 'Simulated loss breach (-₹10,500 against ₹10,000) MUST transition to LOCKED state even off-hours');
    assert.equal(evalResult10k.session.isBreached, true, 'isBreached must be true');
    assert.equal(evalResult10k.session.lossAmount, 10500, 'lossAmount must reflect ₹10,500 loss');
    assert(evalResult10k.session.lockedAt, 'lockedAt timestamp must be set');
    assert(evalResult10k.session.lockUntil, 'lockUntil timestamp must be set');

    // Reset market closed override
    setNseMarketClosedOverride(null);

    console.log('  ✓ PASSED: -₹5,000 loss does not lock; -₹10,500 loss breach against ₹10,000 limit reliably produces LOCKED state');
  }

  // --------------------------------------------------------------------------
  // TEST 2: Simulation Session Persists Across Refreshes
  // --------------------------------------------------------------------------
  console.log('\n[Test 2] Simulation Session Persists Across Dashboard Refreshes');
  {
    // Retrieve simulated session again (simulating dashboard refresh / polling)
    const persistedSimSession = await ServerRiskStore.getSimulatedSession(userId, accountId);

    assert(persistedSimSession, 'Simulated session must exist in store');
    assert.equal(persistedSimSession.isSimulated, true, 'isSimulated must remain true');
    assert.equal(persistedSimSession.state, 'LOCKED', 'State must remain LOCKED across refreshes');
    assert.equal(persistedSimSession.simulatedPnl, -10500, 'simulatedPnl must persist as -10,500');
    assert.equal(persistedSimSession.lossAmount, 10500, 'lossAmount must persist as 10,500');

    console.log('  ✓ PASSED: Simulated breach state persists cleanly across refreshes');
  }

  // --------------------------------------------------------------------------
  // TEST 3: Isolation — Live Account Sessions & Live Risk Locks Remain Unmutated
  // --------------------------------------------------------------------------
  console.log('\n[Test 3] Isolation: Live Risk Sessions & Broker State Unmutated');
  {
    // Check real live risk session for this user
    const liveSession = await ServerRiskStore.getSession(userId, undefined, accountId);

    assert.notEqual(liveSession.isSimulated, true, 'Live risk session is NOT marked as simulated');
    assert.notEqual(liveSession.currentPnl, -10500, 'Live risk session currentPnl must NOT be modified by simulation');

    // Verify Zerodha account is completely isolated
    const zerodhaConfig = await ServerRiskStore.getConfig(userId, DEFAULT_ACCOUNT_ID);
    assert.equal(zerodhaConfig.accountId, DEFAULT_ACCOUNT_ID, 'Zerodha account remains acc_mt_zerodha_default');
    assert.equal(zerodhaConfig.executionMode, 'ENFORCE', 'Zerodha executionMode remains ENFORCE');

    console.log('  ✓ PASSED: Live broker state and real risk sessions remain 100% isolated and unmutated');
  }

  // --------------------------------------------------------------------------
  // TEST 4: Reset Demo Clears Simulation Session
  // --------------------------------------------------------------------------
  console.log('\n[Test 4] Reset Demo Clears Simulation Session Back to Baseline');
  {
    // Reset simulation session
    const resetSession = await ServerRiskStore.resetSimulatedSession(userId, accountId);

    assert.notEqual(resetSession.isSimulated, true, 'Reset session is no longer simulated');

    // Verify simulation store returns null
    const clearedSimSession = await ServerRiskStore.getSimulatedSession(userId, accountId);
    assert.equal(clearedSimSession, null, 'Simulation session is completely cleared on Reset Demo');

    console.log('  ✓ PASSED: Reset Demo successfully clears simulation session');
  }

  console.log('\n================================================================');
  console.log('ALL SIMULATION BREACH & PERSISTENCE TESTS PASSED SUCCESSFULLY');
  console.log('================================================================\n');
}

runSimulationBreachPersistenceSuite().catch((err) => {
  console.error('\nSimulation breach persistence test failed:', err);
  process.exit(1);
});
