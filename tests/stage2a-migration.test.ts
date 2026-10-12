import {
  migrateUserRiskData,
  reconcileRiskConfigs,
  evaluateLockMirroring,
  checkIsLockActive,
  resolveLossLimit,
  isValidLossLimit,
  clearMigrationMockStore,
  setMigrationMockDoc,
  getMigrationMockDoc,
  setMockTransactionFailureInjector,
} from '../server/risk/migration';
import { enableMockStoreForTesting } from '../server/brokers/zerodha/sessionStore';
import { DEFAULT_RISK_CONFIG } from '../src/types/risk';

enableMockStoreForTesting(true);

function assert(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(`ASSERTION FAILED: ${message}`);
  }
}

async function runStage2aSafetyCorrectionTests() {
  console.log('=== RUNNING STAGE 2A SAFETY CORRECTION TESTS ===\n');

  const userId = 'user_safety_test';
  const accountId = 'acc_mt_zerodha_default';
  const tradingDate = '2026-10-12';
  const testNow = new Date('2026-10-12T10:00:00.000Z');

  const validLegacyConfig = {
    dailyLossLimit: 10000,
    warningThreshold1: 70,
    warningThreshold2: 90,
    lockDurationMinutes: 720,
    updatedAt: '2026-10-12T08:00:00.000Z',
  };

  const validAccountConfig = {
    dailyLossLimit: 15000,
    warningThreshold1: 70,
    warningThreshold2: 90,
    lockDurationMinutes: 720,
    updatedAt: '2026-10-12T09:00:00.000Z',
  };

  // --------------------------------------------------------------------------
  // REQ 3.1 & 3.2: Both Configs Missing or Both Configs Invalid -> Fail Closed (0 Writes)
  // --------------------------------------------------------------------------
  console.log('Test 1: Both Configs Missing -> Fail Closed & Zero Writes');
  {
    clearMigrationMockStore();

    // Both missing (null, null)
    const recRes = reconcileRiskConfigs(null, null, testNow);
    assert(recRes.reconciledConfig === undefined, 'Reconciliation must fail when both configs missing');
    assert(recRes.errors !== undefined && recRes.errors.length > 0, 'Explicit error returned');

    const result = await migrateUserRiskData(userId, accountId, tradingDate, testNow);
    assert(result.success === false, 'Migration must fail when both configs missing');
    assert(result.schemaVersion === 0, 'schemaVersion must remain 0');

    // Assert zero writes
    assert(getMigrationMockDoc(`users/${userId}/system/migrationState`) === undefined, 'No migrationState created');
    assert(getMigrationMockDoc(`users/${userId}/accountRiskConfigs/${accountId}`) === undefined, 'No accountRiskConfig created');
    assert(getMigrationMockDoc(`users/${userId}/riskConfig/config`) === undefined, 'No legacy riskConfig created');

    console.log('  PASSED: Both configs missing fails closed with zero writes.');
  }

  console.log('\nTest 2: Both Configs Invalid -> Fail Closed & Zero Writes');
  {
    clearMigrationMockStore();

    const invalidLegacy = { dailyLossLimit: -100 }; // Invalid limit
    const invalidAccount = { warningThreshold1: 150 }; // Invalid percentage

    const recRes = reconcileRiskConfigs(invalidLegacy, invalidAccount, testNow);
    assert(recRes.reconciledConfig === undefined, 'Reconciliation must fail when both configs invalid');

    setMigrationMockDoc(`users/${userId}/riskConfig/config`, invalidLegacy);
    setMigrationMockDoc(`users/${userId}/accountRiskConfigs/${accountId}`, invalidAccount);

    const result = await migrateUserRiskData(userId, accountId, tradingDate, testNow);
    assert(result.success === false, 'Migration must fail when both configs invalid');

    // Assert pre-existing documents were NOT mutated or overwritten
    const legacyDocAfter = getMigrationMockDoc(`users/${userId}/riskConfig/config`);
    assert(JSON.stringify(legacyDocAfter) === JSON.stringify(invalidLegacy), 'Legacy config unmutated');

    const accountDocAfter = getMigrationMockDoc(`users/${userId}/accountRiskConfigs/${accountId}`);
    assert(JSON.stringify(accountDocAfter) === JSON.stringify(invalidAccount), 'Account config unmutated');

    assert(getMigrationMockDoc(`users/${userId}/system/migrationState`) === undefined, 'No migrationState created');

    console.log('  PASSED: Both configs invalid fails closed with zero writes.');
  }

  // --------------------------------------------------------------------------
  // REQ 3.3: One Valid Config & One Invalid Config -> Reconciliation Succeeds
  // --------------------------------------------------------------------------
  console.log('\nTest 3: One Valid Config & One Invalid Config -> Valid Source Selected');
  {
    clearMigrationMockStore();

    const invalidLegacy = { dailyLossLimit: -500 };
    setMigrationMockDoc(`users/${userId}/riskConfig/config`, invalidLegacy);
    setMigrationMockDoc(`users/${userId}/accountRiskConfigs/${accountId}`, validAccountConfig);

    const result = await migrateUserRiskData(userId, accountId, tradingDate, testNow);
    assert(result.success === true, 'Migration should succeed using valid account config');
    assert(result.reconciledConfig?.dailyLossLimit === 15000, 'Valid account config limit used');

    console.log('  PASSED: Valid source config selected successfully.');
  }

  // --------------------------------------------------------------------------
  // REQ 3.4: No Legacy Session -> Migration Succeeds with 0 Mirroring
  // --------------------------------------------------------------------------
  console.log('\nTest 4: No Legacy Session -> Migration Succeeds (0 Mirroring)');
  {
    clearMigrationMockStore();

    setMigrationMockDoc(`users/${userId}/riskConfig/config`, validLegacyConfig);

    const result = await migrateUserRiskData(userId, accountId, tradingDate, testNow);
    assert(result.success === true, 'Migration succeeds when no legacy session exists');
    assert(result.sessionMirrored === false, 'No session mirrored');

    assert(getMigrationMockDoc(`users/${userId}/system/migrationState`).schemaVersion === 2, 'Migration state created');
    assert(getMigrationMockDoc(`users/${userId}/accountRiskSessions/${accountId}__${tradingDate}`) === undefined, 'No account session created');

    console.log('  PASSED: No legacy session allows migration without mirroring.');
  }

  // --------------------------------------------------------------------------
  // REQ 3.5: Legacy Session with Matching Trading Date -> Existing Behavior Preserved
  // --------------------------------------------------------------------------
  console.log('\nTest 5: Legacy Session with Matching Trading Date -> Lock Mirrored');
  {
    clearMigrationMockStore();

    const activeLegacySession = {
      tradingDate,
      userId,
      state: 'LOCKED' as const,
      isBreached: true,
      lockedAt: '2026-10-12T09:00:00.000Z',
      lockUntil: '2026-10-12T12:00:00.000Z',
      currentPnl: -12000,
    };

    setMigrationMockDoc(`users/${userId}/riskConfig/config`, validLegacyConfig);
    setMigrationMockDoc(`users/${userId}/riskSessions/${tradingDate}`, activeLegacySession);

    const result = await migrateUserRiskData(userId, accountId, tradingDate, testNow);
    assert(result.success === true, 'Migration succeeds with matching trading date');
    assert(result.sessionMirrored === true, 'Active lock mirrored');

    const mirroredDoc = getMigrationMockDoc(`users/${userId}/accountRiskSessions/${accountId}__${tradingDate}`);
    assert(mirroredDoc !== undefined && mirroredDoc.state === 'LOCKED', 'Account session doc created');
    assert(mirroredDoc.tradingDate === tradingDate, 'tradingDate preserved verbatim');

    console.log('  PASSED: Matching legacy session lock mirrored successfully.');
  }

  // --------------------------------------------------------------------------
  // REQ 3.6 & 3.8: Legacy Session with Missing Trading Date -> Migration Aborted (0 Writes)
  // --------------------------------------------------------------------------
  console.log('\nTest 6: Legacy Session with Missing Trading Date -> Abort Migration & Zero Writes');
  {
    clearMigrationMockStore();

    const missingDateLegacySession = {
      tradingDate: undefined as any,
      userId,
      state: 'LOCKED' as const,
      isBreached: true,
      lockedAt: '2026-10-12T09:00:00.000Z',
      lockUntil: '2026-10-12T12:00:00.000Z',
    };

    const preExistingAccountConfig = { ...validAccountConfig, dailyLossLimit: 50000 };

    // Deep snapshots before migration execution
    const legacyConfigBefore = JSON.parse(JSON.stringify(validLegacyConfig));
    const accountConfigBefore = JSON.parse(JSON.stringify(preExistingAccountConfig));
    const legacySessionBefore = JSON.parse(JSON.stringify(missingDateLegacySession));

    setMigrationMockDoc(`users/${userId}/riskConfig/config`, validLegacyConfig);
    setMigrationMockDoc(`users/${userId}/accountRiskConfigs/${accountId}`, preExistingAccountConfig);
    setMigrationMockDoc(`users/${userId}/riskSessions/${tradingDate}`, missingDateLegacySession);

    const result = await migrateUserRiskData(userId, accountId, tradingDate, testNow);
    assert(result.success === false, 'Migration MUST fail on missing legacy session tradingDate');
    assert(result.schemaVersion === 0, 'schemaVersion remains 0');

    // Deep equality assertions on every seeded document
    const legacyConfigAfter = getMigrationMockDoc(`users/${userId}/riskConfig/config`);
    assert(
      JSON.stringify(legacyConfigAfter) === JSON.stringify(legacyConfigBefore),
      'Legacy riskConfig document must remain completely unmutated (deep equality)'
    );

    const accountConfigAfter = getMigrationMockDoc(`users/${userId}/accountRiskConfigs/${accountId}`);
    assert(
      JSON.stringify(accountConfigAfter) === JSON.stringify(accountConfigBefore),
      'Account riskConfig document must remain completely unmutated (deep equality)'
    );

    const legacySessionAfter = getMigrationMockDoc(`users/${userId}/riskSessions/${tradingDate}`);
    assert(
      JSON.stringify(legacySessionAfter) === JSON.stringify(legacySessionBefore),
      'Legacy riskSession document must remain completely unmutated (deep equality)'
    );

    // Verify absent documents remain strictly absent
    assert(
      getMigrationMockDoc(`users/${userId}/system/migrationState`) === undefined,
      'Absent migrationState document must remain absent'
    );
    assert(
      getMigrationMockDoc(`users/${userId}/accountRiskSessions/${accountId}__${tradingDate}`) === undefined,
      'Absent accountRiskSession document must remain absent'
    );

    console.log('  PASSED: Missing trading date aborts migration with zero writes (verified via deep comparison).');
  }

  // --------------------------------------------------------------------------
  // REQ 3.7 & 3.8: Legacy Session with Mismatched Trading Date -> Migration Aborted (0 Writes)
  // --------------------------------------------------------------------------
  console.log('\nTest 7: Legacy Session with Mismatched Trading Date -> Abort Migration & Zero Writes');
  {
    clearMigrationMockStore();

    const mismatchedLegacySession = {
      tradingDate: '2026-10-11', // Yesterday's date
      userId,
      state: 'LOCKED' as const,
      isBreached: true,
      lockedAt: '2026-10-11T09:00:00.000Z',
      lockUntil: '2026-10-12T12:00:00.000Z',
    };

    const preExistingAccountConfig = { ...validAccountConfig, dailyLossLimit: 60000 };

    // Deep snapshots before migration execution
    const legacyConfigBefore = JSON.parse(JSON.stringify(validLegacyConfig));
    const accountConfigBefore = JSON.parse(JSON.stringify(preExistingAccountConfig));
    const legacySessionBefore = JSON.parse(JSON.stringify(mismatchedLegacySession));

    setMigrationMockDoc(`users/${userId}/riskConfig/config`, validLegacyConfig);
    setMigrationMockDoc(`users/${userId}/accountRiskConfigs/${accountId}`, preExistingAccountConfig);
    setMigrationMockDoc(`users/${userId}/riskSessions/${tradingDate}`, mismatchedLegacySession);

    const result = await migrateUserRiskData(userId, accountId, tradingDate, testNow);
    assert(result.success === false, 'Migration MUST fail on mismatched legacy session tradingDate');
    assert(result.errors !== undefined && result.errors[0].includes('MIGRATION_FAILED_INVALID_SESSION_DATE'), 'Explicit date error returned');

    // Deep equality assertions on every seeded document
    const legacyConfigAfter = getMigrationMockDoc(`users/${userId}/riskConfig/config`);
    assert(
      JSON.stringify(legacyConfigAfter) === JSON.stringify(legacyConfigBefore),
      'Legacy riskConfig document must remain completely unmutated (deep equality)'
    );

    const accountConfigAfter = getMigrationMockDoc(`users/${userId}/accountRiskConfigs/${accountId}`);
    assert(
      JSON.stringify(accountConfigAfter) === JSON.stringify(accountConfigBefore),
      'Account riskConfig document must remain completely unmutated (deep equality)'
    );

    const legacySessionAfter = getMigrationMockDoc(`users/${userId}/riskSessions/${tradingDate}`);
    assert(
      JSON.stringify(legacySessionAfter) === JSON.stringify(legacySessionBefore),
      'Legacy riskSession document must remain completely unmutated (deep equality)'
    );

    // Verify absent documents remain strictly absent
    assert(
      getMigrationMockDoc(`users/${userId}/system/migrationState`) === undefined,
      'Absent migrationState document must remain absent'
    );
    assert(
      getMigrationMockDoc(`users/${userId}/accountRiskSessions/${accountId}__${tradingDate}`) === undefined,
      'Absent accountRiskSession document must remain absent'
    );

    console.log('  PASSED: Mismatched trading date aborts migration with zero writes (verified via deep comparison).');
  }

  // --------------------------------------------------------------------------
  // REQ 3.9: Existing Active Account Locks Protected
  // --------------------------------------------------------------------------
  console.log('\nTest 8: Existing Active Account Lock Protected from Overwriting');
  {
    clearMigrationMockStore();

    const activeLegacySession = {
      tradingDate,
      userId,
      state: 'LOCKED' as const,
      isBreached: true,
      lockedAt: '2026-10-12T08:00:00.000Z',
      lockUntil: '2026-10-12T11:00:00.000Z',
      customTag: 'legacy_lock',
    };

    const activeAccountSession = {
      tradingDate,
      userId,
      accountId,
      state: 'LOCKED' as const,
      isBreached: true,
      lockedAt: '2026-10-12T09:00:00.000Z',
      lockUntil: '2026-10-12T13:00:00.000Z',
      customTag: 'account_lock',
    };

    const accountSessionPath = `users/${userId}/accountRiskSessions/${accountId}__${tradingDate}`;

    setMigrationMockDoc(`users/${userId}/riskConfig/config`, validLegacyConfig);
    setMigrationMockDoc(`users/${userId}/riskSessions/${tradingDate}`, activeLegacySession);
    setMigrationMockDoc(accountSessionPath, activeAccountSession);

    const result = await migrateUserRiskData(userId, accountId, tradingDate, testNow);
    assert(result.success === true, 'Migration succeeds');
    assert(result.sessionMirrored === false, 'Legacy lock must NOT overwrite active account lock');

    const accountSessionAfter = getMigrationMockDoc(accountSessionPath);
    assert(accountSessionAfter.customTag === 'account_lock', 'Existing account lock preserved unmutated');

    console.log('  PASSED: Active account lock protected from overwriting.');
  }

  // --------------------------------------------------------------------------
  // REQ 3.10: Transaction Failure Rollback & Idempotency
  // --------------------------------------------------------------------------
  console.log('\nTest 9: Transaction Rollback & Idempotency Execution');
  {
    clearMigrationMockStore();

    setMigrationMockDoc(`users/${userId}/riskConfig/config`, validLegacyConfig);

    // Transaction failure injection
    setMockTransactionFailureInjector(() => {
      throw new Error('SIMULATED_FIRESTORE_WRITE_FAILURE');
    });

    const failedRun = await migrateUserRiskData(userId, accountId, tradingDate, testNow);
    assert(failedRun.success === false, 'Injected failure returns success: false');
    assert(getMigrationMockDoc(`users/${userId}/system/migrationState`) === undefined, 'No migrationState written on failure');

    setMockTransactionFailureInjector(null);

    // Run 1 (Success)
    const run1 = await migrateUserRiskData(userId, accountId, tradingDate, testNow);
    assert(run1.success === true && run1.skipped === false, 'Run 1 succeeds and writes');

    // Run 2 (Idempotency)
    const run2 = await migrateUserRiskData(userId, accountId, tradingDate, testNow);
    assert(run2.success === true && run2.skipped === true, 'Run 2 skips with schemaVersion 2');

    console.log('  PASSED: Transaction rollback & idempotency confirmed.');
  }

  // --------------------------------------------------------------------------
  // SECTION 6: Admin Runner Arguments, Dry-Run, Backup & Write Mode Gating
  // --------------------------------------------------------------------------
  console.log('\nTest 10: Admin Runner Argument Validation');
  {
    const { runAdminMigrationRunner } = await import('../scripts/run-stage2a-migration');

    // 10.1 Missing userId -> throws
    let threw1 = false;
    try {
      await runAdminMigrationRunner({ userId: '' });
    } catch (e: any) {
      threw1 = true;
      assert(e.message.includes('ARGUMENT_ERROR'), 'Error mentions ARGUMENT_ERROR for missing userId');
    }
    assert(threw1, 'Runner must throw on missing userId');

    // 10.2 Invalid calendar date in dry-run mode -> throws
    let threw2 = false;
    try {
      await runAdminMigrationRunner({ userId, tradingDate: '2026-02-30' });
    } catch (e: any) {
      threw2 = true;
      assert(e.message.includes('Invalid calendar date'), 'Error mentions Invalid calendar date');
    }
    assert(threw2, 'Runner must throw on invalid calendar date (2026-02-30)');

    // 10.3 Missing tradingDate in write mode -> throws
    let threw3 = false;
    try {
      await runAdminMigrationRunner({ userId, confirmWrite: true, tradingDate: '' });
    } catch (e: any) {
      threw3 = true;
      assert(e.message.includes('requires an explicit --tradingDate'), 'Error mentions explicit --tradingDate requirement');
    }
    assert(threw3, 'Runner must throw on missing tradingDate in write mode');

    console.log('  PASSED: Admin runner argument validation verified.');
  }

  console.log('\nTest 11: Admin Runner Dry-Run Zero Writes');
  {
    clearMigrationMockStore();
    const { runAdminMigrationRunner } = await import('../scripts/run-stage2a-migration');

    setMigrationMockDoc(`users/${userId}/riskConfig/config`, validLegacyConfig);

    const dryRunResult = await runAdminMigrationRunner({
      userId,
      accountId,
      tradingDate,
      now: testNow,
      confirmWrite: false, // Default dry-run mode
    });

    assert(dryRunResult.dryRun === true, 'dryRun flag is true');
    if (dryRunResult.dryRun) {
      assert(dryRunResult.valid === true, 'dryRun result reports valid simulation');
      assert(dryRunResult.reconciledConfig?.dailyLossLimit === 10000, 'Reconciled config computed in dry run');
    }

    // Assert zero writes to store
    assert(getMigrationMockDoc(`users/${userId}/system/migrationState`) === undefined, 'No migrationState created in dry run');
    assert(getMigrationMockDoc(`users/${userId}/accountRiskConfigs/${accountId}`) === undefined, 'No accountRiskConfig created in dry run');

    console.log('  PASSED: Dry-run pass performs simulation with zero store writes.');
  }

  console.log('\nTest 12: Admin Runner Backup Verification Failure Handling');
  {
    clearMigrationMockStore();
    const { runAdminMigrationRunner } = await import('../scripts/run-stage2a-migration');

    setMigrationMockDoc(`users/${userId}/riskConfig/config`, validLegacyConfig);

    const backupFailRes = await runAdminMigrationRunner({
      userId,
      accountId,
      tradingDate,
      now: testNow,
      confirmWrite: true,
      backupDir: './test_backups',
      failBackupForTest: true, // Inject backup failure
    });

    assert(backupFailRes.dryRun !== true, 'Not executed in dry-run mode');
    if (!backupFailRes.dryRun) {
      assert((backupFailRes as any).success === false, 'Migration aborted due to backup failure');
      assert((backupFailRes as any).schemaVersion === 0, 'schemaVersion remains 0 on backup failure');
      assert((backupFailRes as any).errors !== undefined && (backupFailRes as any).errors[0].includes('BACKUP_VERIFICATION_FAILED'), 'Explicit backup error reported');
    }

    // Assert zero writes occurred after backup failure
    assert(getMigrationMockDoc(`users/${userId}/system/migrationState`) === undefined, 'No migrationState created on backup failure');

    console.log('  PASSED: Backup verification failure aborts migration with zero writes.');
  }

  console.log('\nTest 13: Admin Runner Write Mode Execution & Backup Creation');
  {
    clearMigrationMockStore();
    const { runAdminMigrationRunner } = await import('../scripts/run-stage2a-migration');

    setMigrationMockDoc(`users/${userId}/riskConfig/config`, validLegacyConfig);

    const writeResult = await runAdminMigrationRunner({
      userId,
      accountId,
      tradingDate,
      now: testNow,
      confirmWrite: true,
      backupDir: './test_backups',
    });

    assert(writeResult.dryRun !== true, 'Executed in write mode');
    if (!writeResult.dryRun) {
      assert((writeResult as any).success === true, 'Migration write mode succeeded');
      assert((writeResult as any).backupPath !== undefined, 'Backup path returned');
    }

    // Assert write occurred
    const metaDoc = getMigrationMockDoc(`users/${userId}/system/migrationState`);
    assert(metaDoc !== undefined && metaDoc.schemaVersion === 2, 'migrationState schemaVersion 2 written');

    console.log('  PASSED: Write mode execution creates verified backup and updates migration store.');
  }

  console.log('\nTest 14: Post-Backup Concurrent Mutation Detection (Stale Backup Guard)');
  {
    clearMigrationMockStore();
    const { createAndVerifyBackup } = await import('../scripts/run-stage2a-migration');

    // 1. Seed initial document state
    setMigrationMockDoc(`users/${userId}/riskConfig/config`, validLegacyConfig);

    // 2. Create snapshot backup
    const backupRes = await createAndVerifyBackup(userId, accountId, tradingDate, './test_backups');
    assert(backupRes.success === true, 'Backup snapshot created successfully');

    // 3. Mutate a document in store post-backup (simulating concurrent user activity)
    const mutatedConfig = { ...validLegacyConfig, dailyLossLimit: 25000 };
    setMigrationMockDoc(`users/${userId}/riskConfig/config`, mutatedConfig);

    // 4. Attempt migration passing the stale backup
    const staleRunResult = await migrateUserRiskData(userId, accountId, tradingDate, testNow, backupRes.backup);
    assert(staleRunResult.success === false, 'Migration MUST fail when post-backup document mutation is detected');
    assert(
      staleRunResult.errors !== undefined && staleRunResult.errors[0].includes('BACKUP_STALE_CONCURRENT_MUTATION'),
      'Explicit BACKUP_STALE_CONCURRENT_MUTATION error returned'
    );

    // 5. Assert zero writes occurred after staleness detection
    assert(getMigrationMockDoc(`users/${userId}/system/migrationState`) === undefined, 'No migrationState created on stale backup failure');

    console.log('  PASSED: Post-backup document mutation detected and migration aborted with zero writes.');
  }

  console.log('\nTest 15: Store Mode Mismatch Safeguard Enforcement');
  {
    clearMigrationMockStore();
    const { runAdminMigrationRunner } = await import('../scripts/run-stage2a-migration');

    // Attempt to request real Firestore (useMockStore: false) when test suite has isMockStoreEnabled() === true
    let threwMismatch = false;
    try {
      await runAdminMigrationRunner({
        userId,
        accountId,
        tradingDate,
        confirmWrite: true,
        useMockStore: false, // Mismatch with test environment
      });
    } catch (e: any) {
      threwMismatch = true;
      assert(e.message.includes('STORE_MODE_MISMATCH'), 'Error mentions STORE_MODE_MISMATCH');
    }
    assert(threwMismatch, 'Runner must throw STORE_MODE_MISMATCH when requested store mode conflicts with active environment');

    console.log('  PASSED: Store mode mismatch safeguard enforced.');
  }

  console.log('\n=== ALL STAGE 2A SAFETY CORRECTION & ADMIN RUNNER TESTS PASSED SUCCESSFULLY ===');
}

runStage2aSafetyCorrectionTests().catch((err) => {
  console.error('\nSTAGE 2A SAFETY CORRECTION TESTS FAILED:', err);
  process.exit(1);
});
