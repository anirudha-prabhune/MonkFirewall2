import { strict as assert } from 'assert';
import {
  ServerRiskStore,
  DEFAULT_ACCOUNT_ID,
  DEFAULT_ANGELONE_ACCOUNT_ID,
} from '../server/risk/store';
import {
  setAdminFirestoreForTesting,
  enableMockStoreForTesting,
} from '../server/brokers/zerodha/sessionStore';
import { PnlResult } from '../server/pnl/types';

async function runPhase7B1Suite() {
  console.log('================================================================');
  console.log('MONKTRADES PHASE 7B.1: INDEPENDENT ACCOUNT RISK TEST SUITE');
  console.log('Account-Scoped Risk Configs, Session Isolation & Zero Zerodha Leakage');
  console.log('================================================================\n');

  // Ensure mock store is enabled for test environment
  enableMockStoreForTesting(true);
  setAdminFirestoreForTesting(null);
  ServerRiskStore.reset();

  const testUserId = 'user_phase7b_multiaccount_' + Date.now();

  // --------------------------------------------------------------------------
  // TEST 1: Default Zerodha Backward Compatibility & Dual-Write Protocol
  // --------------------------------------------------------------------------
  console.log('[Test 1] Default Zerodha Backward Compatibility & Dual-Write Protocol');
  {
    // Omitted accountId resolves to DEFAULT_ACCOUNT_ID ('acc_mt_zerodha_default')
    const defaultConfig = await ServerRiskStore.getConfig(testUserId);
    assert.equal(defaultConfig.dailyLossLimit, 10000);
    assert.equal(defaultConfig.enabled, true);

    // Save update to default account
    const saveRes = await ServerRiskStore.saveConfig(testUserId, {
      dailyLossLimit: 15000,
      warningThreshold1: 70,
      warningThreshold2: 85,
      lockDurationMinutes: 120,
      lockDurationType: 'FIXED',
      includeRealisedPnl: true,
      includeUnrealisedPnl: true,
      enabled: true,
    });
    assert.equal(saveRes.success, true);
    assert.equal(saveRes.config?.dailyLossLimit, 15000);

    // Explicit query for DEFAULT_ACCOUNT_ID matches
    const explicitDefaultConfig = await ServerRiskStore.getConfig(testUserId, DEFAULT_ACCOUNT_ID);
    assert.equal(explicitDefaultConfig.dailyLossLimit, 15000);

    console.log('  ✓ PASSED: Default Zerodha configuration resolves and saves seamlessly');
  }

  // --------------------------------------------------------------------------
  // TEST 2: Angel One Provisioning & Default OBSERVE_ONLY Execution Mode
  // --------------------------------------------------------------------------
  console.log('\n[Test 2] Angel One Account Provisioning & OBSERVE_ONLY Execution Mode');
  {
    const angelConfig = await ServerRiskStore.getConfig(testUserId, DEFAULT_ANGELONE_ACCOUNT_ID);
    assert.equal(angelConfig.dailyLossLimit, 10000);
    assert.equal(angelConfig.executionMode, 'OBSERVE_ONLY');
    assert.equal(angelConfig.broker, 'angelone');

    // Zerodha config remains 15000 from Test 1
    const zerodhaConfig = await ServerRiskStore.getConfig(testUserId, DEFAULT_ACCOUNT_ID);
    assert.equal(zerodhaConfig.dailyLossLimit, 15000);

    // Update Angel One config to independent limit (e.g. 25000)
    const saveAngelRes = await ServerRiskStore.saveConfig(
      testUserId,
      {
        dailyLossLimit: 25000,
        warningThreshold1: 60,
        warningThreshold2: 80,
        lockDurationMinutes: 60,
        lockDurationType: 'FIXED',
        includeRealisedPnl: true,
        includeUnrealisedPnl: true,
        enabled: true,
        executionMode: 'OBSERVE_ONLY',
        broker: 'angelone',
      },
      DEFAULT_ANGELONE_ACCOUNT_ID
    );
    assert.equal(saveAngelRes.success, true);
    assert.equal(saveAngelRes.config?.dailyLossLimit, 25000);

    // Verify Zerodha config was NOT modified by Angel One update
    const zerodhaAfterAngelUpdate = await ServerRiskStore.getConfig(testUserId, DEFAULT_ACCOUNT_ID);
    assert.equal(zerodhaAfterAngelUpdate.dailyLossLimit, 15000, 'Zerodha config remains 15000 (unpolluted)');

    console.log('  ✓ PASSED: Angel One receives independent OBSERVE_ONLY config without altering Zerodha');
  }

  // --------------------------------------------------------------------------
  // TEST 3: Zero Cross-Broker Lock Leakage (Angel One Breach Does NOT Lock Zerodha)
  // --------------------------------------------------------------------------
  console.log('\n[Test 3] Zero Cross-Broker Lock Leakage (Angel One Breach → No Zerodha Lock)');
  {
    const today = new Date().toISOString().split('T')[0];

    // Synthetic Angel One P&L exceeding its 25000 loss limit (-30,000)
    const angelBreachPnl: PnlResult = {
      tradingDate: today,
      realisedPnl: -30000,
      unrealisedPnl: 0,
      totalPnl: -30000,
      grossTradingPnl: -30000,
      dailyRealisedPnl: -30000,
      dailyUnrealisedPnl: 0,
      includedRealisedPnl: -30000,
      includedUnrealisedPnl: 0,
      fnoPositionCount: 2,
      totalPositionCount: 2,
      positions: [],
      source: 'SYNTHETIC_SIMULATION',
      calculatedAt: new Date().toISOString(),
    };

    // Evaluate Angel One P&L
    const angelEvalRes = await ServerRiskStore.evaluatePnlResult(
      testUserId,
      angelBreachPnl,
      new Date(),
      undefined,
      DEFAULT_ANGELONE_ACCOUNT_ID
    );

    // Angel One session is breached but non-locking because executionMode is OBSERVE_ONLY
    assert.equal(angelEvalRes.isBreached, true, 'Angel One records breach');
    assert.equal(angelEvalRes.state, 'WARNING', 'Angel One remains WARNING (non-locking) in OBSERVE_ONLY mode');
    assert.equal(angelEvalRes.lockedAt, null, 'No lock created for OBSERVE_ONLY account');

    // Verify Zerodha lock status remains strictly ALLOW
    const zerodhaLockStatus = await ServerRiskStore.getLockStatus(testUserId, DEFAULT_ACCOUNT_ID);
    assert.equal(zerodhaLockStatus.locked, false, 'Zerodha remains unlocked');
    assert.equal(zerodhaLockStatus.state, 'ALLOW', 'Zerodha state remains ALLOW');

    console.log('  ✓ PASSED: Angel One loss breach evaluates in observe mode without locking Zerodha');
  }

  // --------------------------------------------------------------------------
  // TEST 4: Zerodha Lock Enforcement Isolation (Zerodha Breach Does NOT Lock Angel One)
  // --------------------------------------------------------------------------
  console.log('\n[Test 4] Zerodha Lock Enforcement Isolation (Zerodha Breach → Only Zerodha Locked)');
  {
    const today = new Date().toISOString().split('T')[0];

    // Synthetic Zerodha P&L exceeding its 15000 limit (-20,000)
    const zerodhaBreachPnl: PnlResult = {
      tradingDate: today,
      realisedPnl: -20000,
      unrealisedPnl: 0,
      totalPnl: -20000,
      grossTradingPnl: -20000,
      dailyRealisedPnl: -20000,
      dailyUnrealisedPnl: 0,
      includedRealisedPnl: -20000,
      includedUnrealisedPnl: 0,
      fnoPositionCount: 1,
      totalPositionCount: 1,
      positions: [],
      source: 'SYNTHETIC_SIMULATION',
      calculatedAt: new Date().toISOString(),
    };

    const zerodhaEvalRes = await ServerRiskStore.evaluatePnlResult(
      testUserId,
      zerodhaBreachPnl,
      new Date(),
      undefined,
      DEFAULT_ACCOUNT_ID
    );

    assert.equal(zerodhaEvalRes.isBreached, true);
    assert.equal(zerodhaEvalRes.state, 'LOCKED', 'Zerodha transitions to LOCKED state');
    assert(zerodhaEvalRes.lockedAt !== null, 'Zerodha lockedAt generated');

    // Verify Zerodha lock status is now LOCKED
    const zerodhaLockStatus = await ServerRiskStore.getLockStatus(testUserId, DEFAULT_ACCOUNT_ID);
    assert.equal(zerodhaLockStatus.locked, true);
    assert.equal(zerodhaLockStatus.state, 'LOCKED');

    // Verify Angel One lock status remains completely independent
    const angelLockStatus = await ServerRiskStore.getLockStatus(testUserId, DEFAULT_ANGELONE_ACCOUNT_ID);
    assert.equal(angelLockStatus.locked, false, 'Angel One remains unlocked');
    assert.notEqual(angelLockStatus.state, 'LOCKED', 'Angel One state is not LOCKED');

    console.log('  ✓ PASSED: Zerodha lock creation is strictly isolated to Zerodha account');
  }

  // --------------------------------------------------------------------------
  // TEST 5: Account-Scoped Immutability Guard Testing
  // --------------------------------------------------------------------------
  console.log('\n[Test 5] Account-Scoped Immutability Guard Testing');
  {
    // While Zerodha is LOCKED, mutating Zerodha dailyLossLimit is rejected
    const zerodhaMutationRes = await ServerRiskStore.saveConfig(
      testUserId,
      {
        dailyLossLimit: 50000, // Attempted mutation
        warningThreshold1: 70,
        warningThreshold2: 85,
        lockDurationMinutes: 120,
        lockDurationType: 'FIXED',
        includeRealisedPnl: true,
        includeUnrealisedPnl: true,
        enabled: true,
      },
      DEFAULT_ACCOUNT_ID
    );
    assert.equal(zerodhaMutationRes.success, false, 'Zerodha config mutation rejected while LOCKED');
    assert.equal(zerodhaMutationRes.code, 'RISK_CONFIG_LOCKED');

    // Meanwhile, Angel One config can be updated freely because Angel One is NOT locked
    const angelMutationRes = await ServerRiskStore.saveConfig(
      testUserId,
      {
        dailyLossLimit: 30000,
        warningThreshold1: 60,
        warningThreshold2: 80,
        lockDurationMinutes: 60,
        lockDurationType: 'FIXED',
        includeRealisedPnl: true,
        includeUnrealisedPnl: true,
        enabled: true,
        executionMode: 'OBSERVE_ONLY',
        broker: 'angelone',
      },
      DEFAULT_ANGELONE_ACCOUNT_ID
    );
    assert.equal(angelMutationRes.success, true, 'Unlocked Angel One config updated successfully');

    console.log('  ✓ PASSED: Lock immutability applies strictly to the locked account without blocking unlocked accounts');
  }

  console.log('\n================================================================');
  console.log('ALL PHASE 7B.1 INDEPENDENT ACCOUNT RISK TESTS PASSED');
  console.log('================================================================\n');
}

runPhase7B1Suite().catch((err) => {
  console.error('\nPhase 7B.1 Suite Failed:', err);
  process.exit(1);
});
