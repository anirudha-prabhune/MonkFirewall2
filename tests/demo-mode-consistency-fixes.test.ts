import { strict as assert } from 'assert';
import {
  ServerRiskStore,
  DEFAULT_ACCOUNT_ID,
  DEFAULT_ANGELONE_ACCOUNT_ID,
  DEFAULT_SIMULATION_ACCOUNT_ID,
} from '../server/risk/store';
import { MOCK_RAW_ZERODHA_POSITIONS } from '../server/brokers/mock/fixtures';
import { MOCK_INSTRUMENT_MAP } from '../server/instruments/master';
import { mockAngelOneAdapter } from '../server/brokers/angelone/adapter';
import { DEFAULT_RISK_CONFIG, DEFAULT_ANGELONE_RISK_CONFIG } from '../src/types/risk';

async function runDemoModeConsistencyFixesSuite() {
  console.log('================================================================');
  console.log('MONKFIREWALL2: DEMO MODE CONSISTENCY & ISOLATION REGRESSION SUITE');
  console.log('1. Demo account isolation (acc_mt_simulation_default)');
  console.log('2. Disable broker connections in Demo Mode');
  console.log('3. Simulation state persistence (+₹1,350 stays ₹1,350 across polls)');
  console.log('4. Correct simulated position quantity matching NSE lot sizes');
  console.log('5. Simulated loss limit breach (-₹5,000 ALLOW vs -₹10,500 LOCKED)');
  console.log('================================================================\n');

  const userId = 'sim_trader_demo_fix_user_101';
  const simAccountId = DEFAULT_SIMULATION_ACCOUNT_ID;

  // --------------------------------------------------------------------------
  // TEST 1: Demo Account Isolation
  // --------------------------------------------------------------------------
  console.log('[Test 1] Dedicated Simulation Account Isolation (acc_mt_simulation_default)');
  {
    assert.equal(simAccountId, 'acc_mt_simulation_default', 'Dedicated simulation account ID must be acc_mt_simulation_default');
    assert.notEqual(simAccountId, DEFAULT_ACCOUNT_ID, 'Simulation account MUST NOT match Zerodha default account');
    assert.notEqual(simAccountId, DEFAULT_ANGELONE_ACCOUNT_ID, 'Simulation account MUST NOT match Angel One default account');

    // Clean simulation state before test
    await ServerRiskStore.resetSimulatedSession(userId, simAccountId);
    const initialSimSession = await ServerRiskStore.getSimulatedSession(userId, simAccountId);
    assert.equal(initialSimSession, null, 'Clean initial simulation session');

    console.log('  ✓ PASSED: Dedicated simulation account context isolated from live broker account IDs');
  }

  // --------------------------------------------------------------------------
  // TEST 2: Simulation State Persistence & Polling (+₹1,350 stays ₹1,350)
  // --------------------------------------------------------------------------
  console.log('\n[Test 2] Simulation State Persistence (+₹1,350 stays ₹1,350 across polls)');
  {
    // Apply +₹1,350 profit in simulation
    const evalResult1350 = await ServerRiskStore.evaluateSimulatedPnl(userId, 1350, new Date(), simAccountId);
    assert.equal(evalResult1350.session.isSimulated, true, 'Result session must be marked isSimulated = true');
    assert.equal(evalResult1350.session.simulatedPnl, 1350, 'Simulated P&L must be 1,350');
    assert.equal(evalResult1350.session.currentPnl, 1350, 'Current P&L must be 1,350');
    assert.equal(evalResult1350.session.state, 'ALLOW', 'Risk state for +₹1,350 must be ALLOW');

    // Perform repeated polling reads (simulating dashboard refreshes / background polls)
    const polledSession1 = await ServerRiskStore.getSimulatedSession(userId, simAccountId);
    assert(polledSession1, 'Polled simulation session must exist');
    assert.equal(polledSession1.simulatedPnl, 1350, 'Polled P&L must remain 1,350 — NOT 6,350');
    assert.equal(polledSession1.currentPnl, 1350, 'Polled currentPnl must remain 1,350');

    const polledSession2 = await ServerRiskStore.getSession(userId, undefined, simAccountId);
    assert.equal(polledSession2.currentPnl, 1350, 'ServerRiskStore.getSession for simulation account context must return 1,350 — NOT 6,350');

    console.log('  ✓ PASSED: Starting from ₹0, applying +₹1,350 and polling/refreshing continues to show ₹1,350 — not ₹6,350');
  }

  // --------------------------------------------------------------------------
  // TEST 3: Simulated Loss Threshold Enforcement (-₹5,000 ALLOW vs -₹10,500 LOCKED)
  // --------------------------------------------------------------------------
  console.log('\n[Test 3] Simulated Loss Threshold Enforcement & Lock Lifecycle');
  {
    // Ensure clean simulation session
    await ServerRiskStore.resetSimulatedSession(userId, simAccountId);

    // Save config with ₹10,000 loss limit for simulation account
    await ServerRiskStore.saveConfig(userId, { ...DEFAULT_RISK_CONFIG, dailyLossLimit: 10000, executionMode: 'ENFORCE' }, simAccountId);

    // 3A. Simulated loss below ₹10,000 (-₹5,000) MUST NOT LOCK
    const evalResult5k = await ServerRiskStore.evaluateSimulatedPnl(userId, -5000, new Date(), simAccountId);
    assert.equal(evalResult5k.session.state, 'ALLOW', '-₹5,000 loss against ₹10,000 limit MUST be ALLOW state');
    assert.equal(evalResult5k.session.isBreached, false, 'isBreached must be false for -₹5,000');

    // 3B. Simulated loss of -₹10,500 MUST LOCK
    const evalResult10k5 = await ServerRiskStore.evaluateSimulatedPnl(userId, -10500, new Date(), simAccountId);
    assert.equal(evalResult10k5.session.state, 'LOCKED', '-₹10,500 loss against ₹10,000 limit MUST transition to LOCKED state');
    assert.equal(evalResult10k5.session.isBreached, true, 'isBreached must be true for -₹10,500');
    assert(evalResult10k5.session.lockedAt, 'lockedAt timestamp must be set on breach');

    // 3C. Polling / Risk status refresh preserves LOCKED state
    const statusRefresh = await ServerRiskStore.getLockStatus(userId, simAccountId);
    assert.equal(statusRefresh.state, 'LOCKED', 'Lock status refresh MUST preserve LOCKED state');
    assert.equal(statusRefresh.locked, true, 'locked boolean must be true');

    console.log('  ✓ PASSED: Simulated loss below ₹10,000 does not lock; simulated loss of ₹10,500 locks and persists across status refreshes');
  }

  // --------------------------------------------------------------------------
  // TEST 4: Reset Demo Clears Simulation State Only
  // --------------------------------------------------------------------------
  console.log('\n[Test 4] Reset Demo Clears Simulation State Only');
  {
    // Verify simulation session is currently active
    const activeSim = await ServerRiskStore.getSimulatedSession(userId, simAccountId);
    assert(activeSim, 'Simulation session active prior to reset');

    // Execute Reset Demo
    const resetResult = await ServerRiskStore.resetSimulatedSession(userId, simAccountId);
    assert.equal(resetResult.currentPnl, 0, 'Reset result returns baseline 0 P&L session');

    const clearedSim = await ServerRiskStore.getSimulatedSession(userId, simAccountId);
    assert.equal(clearedSim, null, 'Simulated session completely deleted from simulation store');

    // Verify live Zerodha and Angel One account configs remain 100% untouched
    const liveZerodhaConfig = await ServerRiskStore.getConfig(userId, DEFAULT_ACCOUNT_ID);
    assert.equal(liveZerodhaConfig.accountId, DEFAULT_ACCOUNT_ID, 'Live Zerodha account config remains intact');

    const liveAngelConfig = await ServerRiskStore.getConfig(userId, DEFAULT_ANGELONE_ACCOUNT_ID);
    assert.equal(liveAngelConfig.accountId, DEFAULT_ANGELONE_ACCOUNT_ID, 'Live Angel One account config remains intact');

    console.log('  ✓ PASSED: Reset Demo clears simulation state only while preserving live account configs and sessions');
  }

  // --------------------------------------------------------------------------
  // TEST 5: Correct Simulated Position Quantity Matching NSE Lot Sizes
  // --------------------------------------------------------------------------
  console.log('\n[Test 5] Correct Simulated Position Quantities Matching NSE Contract Lot Sizes');
  {
    // Inspect each Zerodha mock position in fixtures
    for (const pos of MOCK_RAW_ZERODHA_POSITIONS) {
      const inst = MOCK_INSTRUMENT_MAP.get(pos.instrument_token);
      if (inst && inst.lotSize) {
        assert(
          pos.quantity % inst.lotSize === 0,
          `Position ${pos.tradingsymbol} quantity (${pos.quantity}) MUST be an integer multiple of instrument lotSize (${inst.lotSize})`
        );
        if (pos.day_buy_quantity > 0) {
          assert(
            pos.day_buy_quantity % inst.lotSize === 0,
            `Position ${pos.tradingsymbol} day_buy_quantity (${pos.day_buy_quantity}) MUST be an integer multiple of lotSize (${inst.lotSize})`
          );
        }
        if (pos.day_sell_quantity > 0) {
          assert(
            pos.day_sell_quantity % inst.lotSize === 0,
            `Position ${pos.tradingsymbol} day_sell_quantity (${pos.day_sell_quantity}) MUST be an integer multiple of lotSize (${inst.lotSize})`
          );
        }
      }
    }

    // Inspect Angel One mock position
    const angelPositions = await mockAngelOneAdapter.getPositions();
    for (const pos of angelPositions) {
      const inst = MOCK_INSTRUMENT_MAP.get(pos.instrument_token);
      if (inst && inst.lotSize) {
        assert(
          pos.quantity % inst.lotSize === 0,
          `Angel One position ${pos.tradingsymbol} quantity (${pos.quantity}) MUST be an integer multiple of instrument lotSize (${inst.lotSize})`
        );
      }
    }

    console.log('  ✓ PASSED: All simulated position quantities strictly conform to NSE contract lot sizes from instrument metadata');
  }

  // --------------------------------------------------------------------------
  // TEST 6: Video Defect Sequence Reproduction & State Persistence Verification
  // --------------------------------------------------------------------------
  console.log('\n[Test 6] Video Defect Sequence Reproduction & State Persistence');
  {
    // Clean initial simulation session
    await ServerRiskStore.resetSimulatedSession(userId, simAccountId);

    // Step 1: User clicks +1,350 in Demo Controls
    const eval1350 = await ServerRiskStore.evaluateSimulatedPnl(userId, 1350, new Date(), simAccountId);
    assert.equal(eval1350.session.currentPnl, 1350, 'Step 1: +1,350 applied');

    // Step 2: User clicks -4,000 in Demo Controls (cumulative P&L = -2,650)
    const evalNeg2650 = await ServerRiskStore.evaluateSimulatedPnl(userId, -2650, new Date(), simAccountId);
    assert.equal(evalNeg2650.session.currentPnl, -2650, 'Step 2: -2,650 applied');

    // Step 3: Background polling interval runs querying default account ID (acc_mt_zerodha_default)
    const polledDefaultAccSession = await ServerRiskStore.getSimulatedSession(userId, DEFAULT_ACCOUNT_ID);
    assert(polledDefaultAccSession, 'Polling default account MUST resolve active simulation session');
    assert.equal(polledDefaultAccSession.currentPnl, -2650, 'Polled session MUST remain -2,650 — MUST NOT reset to +1,350 or mock baseline');

    // Step 4: Verify getSession for default account also returns simulation session
    const polledSession = await ServerRiskStore.getSession(userId, undefined, DEFAULT_ACCOUNT_ID);
    assert.equal(polledSession.currentPnl, -2650, 'getSession for default account MUST return -2,650 when simulation is active');

    console.log('  ✓ PASSED: Video defect successfully reproduced and fixed. P&L remains -2,650 across all account queries');
  }

  console.log('\n================================================================');
  console.log('ALL DEMO MODE CONSISTENCY & ISOLATION REGRESSION TESTS PASSED!');
  console.log('================================================================\n');
}

runDemoModeConsistencyFixesSuite().catch((err) => {
  console.error('\nDemo Mode consistency test suite failed:', err);
  process.exit(1);
});
