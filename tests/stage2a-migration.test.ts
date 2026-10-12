import {
  migrateUserRiskData,
  reconcileRiskConfigs,
  evaluateLockMirroring,
  clearMigrationMockStore,
  setMigrationMockDoc,
  getMigrationMockDoc,
} from '../server/risk/migration';
import { enableMockStoreForTesting } from '../server/brokers/zerodha/sessionStore';
import { DEFAULT_RISK_CONFIG } from '../src/types/risk';

enableMockStoreForTesting(true);

function assert(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(`ASSERTION FAILED: ${message}`);
  }
}

async function runStage2aMigrationTests() {
  console.log('=== RUNNING STAGE 2A MIGRATION UTILITY TESTS ===\n');

  const userId = 'user_migration_test_1';
  const accountId = 'acc_mt_zerodha_default';
  const tradingDate = '2026-10-12';
  const testNow = new Date('2026-10-12T10:00:00.000Z');

  // --------------------------------------------------------------------------
  // TEST 1: Reconcile Risk Configs - Legacy Newer vs Account Newer vs Equal
  // --------------------------------------------------------------------------
  console.log('Test 1: Reconcile Risk Configs - Timestamp Precedence');
  {
    const legacyNewer = {
      dailyLossLimit: 15000,
      warningThreshold1: 70,
      warningThreshold2: 90,
      lockDurationMinutes: 720,
      updatedAt: '2026-10-12T09:00:00.000Z',
    };
    const accountOlder = {
      dailyLossLimit: 10000,
      warningThreshold1: 70,
      warningThreshold2: 90,
      lockDurationMinutes: 720,
      updatedAt: '2026-10-12T08:00:00.000Z',
    };

    const res1 = reconcileRiskConfigs(legacyNewer, accountOlder, testNow);
    assert(res1.reconciledConfig !== undefined, 'res1 reconciledConfig should be defined');
    assert(
      res1.reconciledConfig?.dailyLossLimit === 15000,
      'Legacy config (newer timestamp) should win'
    );

    const legacyOlder = {
      dailyLossLimit: 15000,
      warningThreshold1: 70,
      warningThreshold2: 90,
      lockDurationMinutes: 720,
      updatedAt: '2026-10-12T08:00:00.000Z',
    };
    const accountNewer = {
      dailyLossLimit: 20000,
      warningThreshold1: 70,
      warningThreshold2: 90,
      lockDurationMinutes: 720,
      updatedAt: '2026-10-12T09:00:00.000Z',
    };

    const res2 = reconcileRiskConfigs(legacyOlder, accountNewer, testNow);
    assert(
      res2.reconciledConfig?.dailyLossLimit === 20000,
      'Account config (newer timestamp) should win'
    );

    const legacyEqual = {
      dailyLossLimit: 15000,
      warningThreshold1: 70,
      warningThreshold2: 90,
      lockDurationMinutes: 720,
      updatedAt: '2026-10-12T08:00:00.000Z',
    };
    const accountEqual = {
      dailyLossLimit: 25000,
      warningThreshold1: 70,
      warningThreshold2: 90,
      lockDurationMinutes: 720,
      updatedAt: '2026-10-12T08:00:00.000Z',
    };

    const res3 = reconcileRiskConfigs(legacyEqual, accountEqual, testNow);
    assert(
      res3.reconciledConfig?.dailyLossLimit === 25000,
      'Account config should win on equal timestamps'
    );

    console.log('  PASSED: Timestamp precedence & account fallback rules verified.');
  }

  // --------------------------------------------------------------------------
  // TEST 2: Legacy maxLoss Alias Fallback & Document Sanitization
  // --------------------------------------------------------------------------
  console.log('\nTest 2: Legacy maxLoss Alias Fallback & Document Sanitization');
  {
    const legacyWithMaxLoss = {
      maxLoss: 12500, // Legacy field name
      warningThreshold1: 60,
      warningThreshold2: 85,
      lockDurationMinutes: 360,
      updatedAt: '2026-10-11T12:00:00.000Z',
    };

    const res = reconcileRiskConfigs(legacyWithMaxLoss, null, testNow);
    assert(res.reconciledConfig !== undefined, 'res reconciledConfig should be defined');
    assert(
      res.reconciledConfig?.dailyLossLimit === 12500,
      'Legacy maxLoss should map to dailyLossLimit'
    );
    assert(
      (res.reconciledConfig as any).maxLoss === undefined,
      'Legacy maxLoss property should be deleted from sanitized document'
    );
    assert(res.reconciledConfig?.warningThreshold1 === 60, 'warningThreshold1 preserved');
    assert(res.reconciledConfig?.lockDurationMinutes === 360, 'lockDurationMinutes preserved');

    console.log('  PASSED: maxLoss alias mapped and sanitized successfully.');
  }

  // --------------------------------------------------------------------------
  // TEST 3: Missing Documents Defaults Initialization
  // --------------------------------------------------------------------------
  console.log('\nTest 3: Missing Documents Default Initialization');
  {
    clearMigrationMockStore();

    const result = await migrateUserRiskData(userId, accountId, tradingDate, testNow);
    assert(result.success === true, 'Migration should succeed');
    assert(result.skipped === false, 'Migration should execute writes');
    assert(result.schemaVersion === 2, 'schemaVersion should be 2');
    assert(
      result.reconciledConfig?.dailyLossLimit === DEFAULT_RISK_CONFIG.dailyLossLimit,
      'Should initialize default dailyLossLimit'
    );

    // Verify mock store docs created
    const meta = getMigrationMockDoc(`users/${userId}/system/migrationState`);
    assert(meta && meta.schemaVersion === 2, 'migrationState meta stored in correct path');

    const accConfig = getMigrationMockDoc(`users/${userId}/accountRiskConfigs/${accountId}`);
    assert(accConfig && accConfig.dailyLossLimit === 10000, 'accountRiskConfig initialized');

    const legConfig = getMigrationMockDoc(`users/${userId}/riskConfig/config`);
    assert(legConfig && legConfig.dailyLossLimit === 10000, 'legacy riskConfig synchronized');

    console.log('  PASSED: Missing documents default initialization verified.');
  }

  // --------------------------------------------------------------------------
  // TEST 4: Active Lock Mirroring & Legacy Immutability
  // --------------------------------------------------------------------------
  console.log('\nTest 4: Active Lock Mirroring & Legacy Immutability');
  {
    clearMigrationMockStore();

    const activeLockUntil = new Date(testNow.getTime() + 2 * 60 * 60 * 1000).toISOString();
    const legacySessionDoc = {
      tradingDate,
      userId,
      state: 'LOCKED',
      isBreached: true,
      lockedAt: '2026-10-12T09:00:00.000Z',
      lockUntil: activeLockUntil,
      currentPnl: -12000,
      realisedPnl: -12000,
      unrealisedPnl: 0,
      lossLimit: 10000,
      warningThreshold1: 70,
      warningThreshold2: 90,
      lastEvaluatedAt: '2026-10-12T09:00:00.000Z',
      reason: 'Daily loss limit breached',
    };

    const legacySessionPath = `users/${userId}/riskSessions/${tradingDate}`;
    setMigrationMockDoc(legacySessionPath, legacySessionDoc);

    const result = await migrateUserRiskData(userId, accountId, tradingDate, testNow);
    assert(result.success === true, 'Migration should succeed');
    assert(result.sessionMirrored === true, 'Session should be mirrored');

    // Verify account risk session doc was written
    const accountSessionDocPath = `users/${userId}/accountRiskSessions/${accountId}__${tradingDate}`;
    const mirroredDoc = getMigrationMockDoc(accountSessionDocPath);
    assert(mirroredDoc !== null, 'Account session doc created');
    assert(mirroredDoc.state === 'LOCKED', 'Mirrored state is LOCKED');
    assert(mirroredDoc.lockUntil === activeLockUntil, 'lockUntil preserved');
    assert(mirroredDoc.accountId === accountId, 'accountId field attached');

    // Verify legacy risk session doc remains UNTOUCHED
    const legacyAfter = getMigrationMockDoc(legacySessionPath);
    assert(
      JSON.stringify(legacyAfter) === JSON.stringify(legacySessionDoc),
      'Legacy riskSessions doc MUST remain completely untouched and immutable'
    );

    console.log('  PASSED: Active lock mirrored and legacy session doc kept untouched.');
  }

  // --------------------------------------------------------------------------
  // TEST 5: Expired Lock Is NOT Mirrored
  // --------------------------------------------------------------------------
  console.log('\nTest 5: Expired Lock Is NOT Mirrored');
  {
    clearMigrationMockStore();

    const expiredLockUntil = new Date(testNow.getTime() - 10 * 60 * 1000).toISOString();
    const legacyExpiredSessionDoc = {
      tradingDate,
      userId,
      state: 'LOCKED',
      isBreached: true,
      lockedAt: '2026-10-12T07:00:00.000Z',
      lockUntil: expiredLockUntil, // EXPIRED
      currentPnl: -12000,
      realisedPnl: -12000,
      unrealisedPnl: 0,
      lossLimit: 10000,
      warningThreshold1: 70,
      warningThreshold2: 90,
      lastEvaluatedAt: '2026-10-12T07:00:00.000Z',
      reason: 'Daily loss limit breached',
    };

    const legacySessionPath = `users/${userId}/riskSessions/${tradingDate}`;
    setMigrationMockDoc(legacySessionPath, legacyExpiredSessionDoc);

    const result = await migrateUserRiskData(userId, accountId, tradingDate, testNow);
    assert(result.success === true, 'Migration should succeed');
    assert(result.sessionMirrored === false, 'Expired lock should NOT be mirrored');

    const accountSessionDocPath = `users/${userId}/accountRiskSessions/${accountId}__${tradingDate}`;
    const mirroredDoc = getMigrationMockDoc(accountSessionDocPath);
    assert(mirroredDoc === undefined, 'Account session doc should NOT be created for expired lock');

    console.log('  PASSED: Expired lock was correctly ignored and not mirrored.');
  }

  // --------------------------------------------------------------------------
  // TEST 6: Repeated Execution Idempotency (schemaVersion: 2 -> 0 Writes)
  // --------------------------------------------------------------------------
  console.log('\nTest 6: Repeated Execution Idempotency');
  {
    clearMigrationMockStore();

    // First execution
    const run1 = await migrateUserRiskData(userId, accountId, tradingDate, testNow);
    assert(run1.success === true && run1.skipped === false, 'Run 1 executed writes');

    // Record mock store state after Run 1
    const meta1 = getMigrationMockDoc(`users/${userId}/system/migrationState`);
    assert(meta1.schemaVersion === 2, 'schemaVersion is 2');

    // Modify in-memory mock store directly to detect any unwanted mutation on Run 2
    const accConfigPath = `users/${userId}/accountRiskConfigs/${accountId}`;
    const currentConfig = getMigrationMockDoc(accConfigPath);
    currentConfig.dailyLossLimit = 99999;
    setMigrationMockDoc(accConfigPath, currentConfig);

    // Second execution
    const run2 = await migrateUserRiskData(userId, accountId, tradingDate, testNow);
    assert(run2.success === true, 'Run 2 succeeded');
    assert(run2.skipped === true, 'Run 2 was SKIPPED due to idempotency');
    assert(run2.schemaVersion === 2, 'schemaVersion remains 2');

    // Confirm zero writes modified the updated mock store entry
    const afterRun2 = getMigrationMockDoc(accConfigPath);
    assert(
      afterRun2.dailyLossLimit === 99999,
      'Zero writes occurred during Run 2 (config left untransformed)'
    );

    console.log('  PASSED: Second execution was strictly idempotent with 0 writes.');
  }

  console.log('\n=== ALL STAGE 2A MIGRATION UTILITY TESTS PASSED SUCCESSFULLY ===');
}

runStage2aMigrationTests().catch((err) => {
  console.error('\nSTAGE 2A MIGRATION TESTS FAILED:', err);
  process.exit(1);
});
