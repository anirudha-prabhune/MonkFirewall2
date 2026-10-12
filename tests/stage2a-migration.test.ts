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
import fs from 'fs';
import { enableMockStoreForTesting } from '../server/brokers/zerodha/sessionStore';
import { DEFAULT_RISK_CONFIG } from '../src/types/risk';

enableMockStoreForTesting(true);
process.env.NODE_ENV = 'test';

function cleanupTestBackups() {
  if (fs.existsSync('./test_backups')) {
    fs.rmSync('./test_backups', { recursive: true, force: true });
  }
}

function assert(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(`ASSERTION FAILED: ${message}`);
  }
}

async function runStage2aSafetyCorrectionTests() {
  cleanupTestBackups();
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
    const { runAdminMigrationRunnerForIsolatedTesting, createIsolatedTestToken } = await import('../scripts/run-stage2a-migration');

    setMigrationMockDoc(`users/${userId}/riskConfig/config`, validLegacyConfig);
    const testToken = createIsolatedTestToken();

    const backupFailRes = await runAdminMigrationRunnerForIsolatedTesting(
      {
        userId,
        accountId,
        tradingDate,
        now: testNow,
        confirmWrite: true,
        backupDir: './test_backups',
        failBackupForTest: true, // Inject backup failure
      },
      testToken
    );

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
    const { runAdminMigrationRunnerForIsolatedTesting, createIsolatedTestToken } = await import('../scripts/run-stage2a-migration');

    setMigrationMockDoc(`users/${userId}/riskConfig/config`, validLegacyConfig);
    const testToken = createIsolatedTestToken();

    const writeResult = await runAdminMigrationRunnerForIsolatedTesting(
      {
        userId,
        accountId,
        tradingDate,
        now: testNow,
        confirmWrite: true,
        backupDir: './test_backups',
      },
      testToken
    );

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

  console.log('\nTest 16: Active Mock Mode Without Explicit Test Bypass Fails Closed in Write Mode');
  {
    clearMigrationMockStore();
    const { runAdminMigrationRunner } = await import('../scripts/run-stage2a-migration');

    // Call write mode without allowMockForTesting when isMockStoreEnabled() === true
    const res = await runAdminMigrationRunner({
      userId,
      accountId,
      tradingDate,
      now: testNow,
      confirmWrite: true,
      // allowMockForTesting is omitted
    });

    assert(res.dryRun !== true, 'Executed in write mode attempt');
    if (!res.dryRun) {
      assert(res.success === false, 'Write mode in mock mode without allowMockForTesting MUST fail closed');
      assert(
        res.errors !== undefined && res.errors[0].includes('REAL_FIRESTORE_REQUIRED'),
        'Explicit REAL_FIRESTORE_REQUIRED error returned'
      );
    }
    assert(getMigrationMockDoc(`users/${userId}/system/migrationState`) === undefined, 'No migration state created');

    console.log('  PASSED: Active mock mode without explicit test bypass fails closed before writes.');
  }

  console.log('\nTest 17: Missing Firestore in Real Write Mode Fails Closed');
  {
    clearMigrationMockStore();
    const { runAdminMigrationRunner } = await import('../scripts/run-stage2a-migration');
    const { enableMockStoreForTesting } = await import('../server/brokers/zerodha/sessionStore');

    // Temporarily disable mock store to simulate real production mode where Admin SDK is uninitialized
    enableMockStoreForTesting(false);

    try {
      const res = await runAdminMigrationRunner({
        userId,
        accountId,
        tradingDate,
        now: testNow,
        confirmWrite: true,
      });

      assert(res.dryRun !== true, 'Executed in write mode attempt');
      if (!res.dryRun) {
        assert(res.success === false, 'Real write mode MUST fail when Firestore is uninitialized');
        assert(
          res.errors !== undefined && res.errors[0].includes('REAL_FIRESTORE_REQUIRED'),
          'Explicit REAL_FIRESTORE_REQUIRED error returned'
        );
      }
    } finally {
      // Restore mock store for remainder of tests
      enableMockStoreForTesting(true);
    }

    console.log('  PASSED: Missing Firestore in real write mode fails closed before backup or writes.');
  }

  console.log('\nTest 18: Malformed Backup Paths Fail Closed Before Writes');
  {
    clearMigrationMockStore();
    const { verifyBackupPathIntegrity } = await import('../server/risk/migration');

    const expectedPaths = [
      `users/${userId}/system/migrationState`,
      `users/${userId}/riskConfig/config`,
      `users/${userId}/accountRiskConfigs/${accountId}`,
      `users/${userId}/riskSessions/${tradingDate}`,
      `users/${userId}/accountRiskSessions/${accountId}__${tradingDate}`,
    ];

    // 18.1 Missing required path
    const missingOnePath = expectedPaths.slice(0, 4).map((p) => ({ path: p, exists: true, data: {} }));
    const missingRes = verifyBackupPathIntegrity(missingOnePath, expectedPaths);
    assert(missingRes.valid === false, 'verifyBackupPathIntegrity must reject missing path');
    assert(
      missingRes.error !== undefined && (missingRes.error.includes('Required document path missing') || missingRes.error.includes('Expected exactly 5')),
      'Error identifies missing path'
    );

    // 18.2 Duplicate path
    const duplicatePaths = [
      ...expectedPaths.slice(0, 4).map((p) => ({ path: p, exists: true, data: {} })),
      { path: expectedPaths[0], exists: true, data: {} }, // duplicate of index 0
    ];
    const dupRes = verifyBackupPathIntegrity(duplicatePaths, expectedPaths);
    assert(dupRes.valid === false, 'verifyBackupPathIntegrity must reject duplicate path');
    assert(
      dupRes.error !== undefined && dupRes.error.includes('Duplicate document path found'),
      'Error identifies duplicate path'
    );

    // 18.3 Wrong path
    const wrongPaths = [
      ...expectedPaths.slice(0, 4).map((p) => ({ path: p, exists: true, data: {} })),
      { path: 'users/wrong_user/riskConfig/config', exists: true, data: {} },
    ];
    const wrongRes = verifyBackupPathIntegrity(wrongPaths, expectedPaths);
    assert(wrongRes.valid === false, 'verifyBackupPathIntegrity must reject unexpected/wrong path');
    assert(
      wrongRes.error !== undefined && wrongRes.error.includes('Required document path missing'),
      'Error identifies missing required path'
    );

    // 18.4 Malformed backup passed to migrateUserRiskData causes immediate failure with zero writes
    setMigrationMockDoc(`users/${userId}/riskConfig/config`, validLegacyConfig);
    const malformedBackup = {
      userId,
      accountId,
      tradingDate,
      createdAt: new Date().toISOString(),
      documents: duplicatePaths,
    };
    const migrationRes = await migrateUserRiskData(userId, accountId, tradingDate, testNow, malformedBackup);
    assert(migrationRes.success === false, 'migrateUserRiskData must fail closed when backup paths are malformed');
    assert(
      migrationRes.errors !== undefined && migrationRes.errors[0].includes('BACKUP_VERIFICATION_FAILED'),
      'Explicit BACKUP_VERIFICATION_FAILED error returned'
    );
    assert(getMigrationMockDoc(`users/${userId}/system/migrationState`) === undefined, 'Zero writes on malformed backup');

    console.log('  PASSED: Malformed backup paths (missing, duplicate, wrong) fail closed before writes.');
  }

  console.log('\nTest 19: Production Environment (NODE_ENV=production) Rejects allowMockForTesting with Zero Writes');
  {
    clearMigrationMockStore();
    const { runAdminMigrationRunner } = await import('../scripts/run-stage2a-migration');

    setMigrationMockDoc(`users/${userId}/riskConfig/config`, validLegacyConfig);
    const originalNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';

    try {
      const res = await runAdminMigrationRunner({
        userId,
        accountId,
        tradingDate,
        now: testNow,
        confirmWrite: true,
        allowMockForTesting: true, // Attempt bypass in production
      } as any);

      assert(res.dryRun !== true, 'Executed in write mode attempt');
      if (!res.dryRun) {
        assert(res.success === false, 'Production write mode MUST fail closed even if allowMockForTesting is set');
        assert(
          res.errors !== undefined && res.errors[0].includes('PROGRAMMATIC_BYPASS_FORBIDDEN'),
          'Explicit PROGRAMMATIC_BYPASS_FORBIDDEN error returned'
        );
      }
      assert(
        getMigrationMockDoc(`users/${userId}/system/migrationState`) === undefined,
        'Zero writes: no migrationState written in production despite allowMockForTesting flag'
      );
    } finally {
      process.env.NODE_ENV = originalNodeEnv;
    }

    console.log('  PASSED: Production environment strictly rejects allowMockForTesting with zero writes.');
  }

  console.log('\nTest 20: Non-Test Environment (NODE_ENV undefined/development) Rejects allowMockForTesting with Zero Writes');
  {
    clearMigrationMockStore();
    const { runAdminMigrationRunner } = await import('../scripts/run-stage2a-migration');

    setMigrationMockDoc(`users/${userId}/riskConfig/config`, validLegacyConfig);
    const originalNodeEnv = process.env.NODE_ENV;
    delete (process.env as any).NODE_ENV;

    try {
      const res = await runAdminMigrationRunner({
        userId,
        accountId,
        tradingDate,
        now: testNow,
        confirmWrite: true,
        allowMockForTesting: true, // Attempt bypass in non-test env
      } as any);

      assert(res.dryRun !== true, 'Executed in write mode attempt');
      if (!res.dryRun) {
        assert(res.success === false, 'Non-test environment MUST fail closed even if allowMockForTesting is set');
        assert(
          res.errors !== undefined && res.errors[0].includes('PROGRAMMATIC_BYPASS_FORBIDDEN'),
          'Explicit PROGRAMMATIC_BYPASS_FORBIDDEN error returned'
        );
      }
      assert(
        getMigrationMockDoc(`users/${userId}/system/migrationState`) === undefined,
        'Zero writes: no migrationState written in non-test env despite allowMockForTesting flag'
      );
    } finally {
      process.env.NODE_ENV = originalNodeEnv;
    }

    console.log('  PASSED: Non-test environment strictly rejects allowMockForTesting with zero writes.');
  }

  console.log('\nTest 21: CLI Mode Flags Reject allowMockForTesting in Both Runner and Subprocess Execution');
  {
    clearMigrationMockStore();
    const { runAdminMigrationRunner } = await import('../scripts/run-stage2a-migration');
    const { execSync } = await import('child_process');

    // 21.1: Programmatic CLI flag rejection
    const programmaticCliRes = await runAdminMigrationRunner({
      userId,
      accountId,
      tradingDate,
      now: testNow,
      confirmWrite: true,
      allowMockForTesting: true,
      isCli: true,
    } as any);

    assert(programmaticCliRes.dryRun !== true, 'Executed in write mode attempt');
    if (!programmaticCliRes.dryRun) {
      assert(programmaticCliRes.success === false, 'CLI execution MUST fail closed with allowMockForTesting');
      assert(
        programmaticCliRes.errors !== undefined && programmaticCliRes.errors[0].includes('PROGRAMMATIC_BYPASS_FORBIDDEN'),
        'Explicit PROGRAMMATIC_BYPASS_FORBIDDEN error returned'
      );
    }
    assert(
      getMigrationMockDoc(`users/${userId}/system/migrationState`) === undefined,
      'Zero writes: no migrationState written under CLI execution'
    );

    // 21.2: Direct CLI subprocess execution rejection
    let cliFailedAsExpected = false;
    try {
      execSync(
        'npx tsx scripts/run-stage2a-migration.ts --userId=test_user --confirmWrite=true --allowMockForTesting=true',
        { stdio: 'pipe' }
      );
    } catch (err: any) {
      cliFailedAsExpected = true;
      const stderr = err.stderr ? err.stderr.toString() : '';
      assert(
        stderr.includes('CLI_ERROR') && stderr.includes('forbidden in CLI execution'),
        'CLI output explicitly reports mock testing flags forbidden'
      );
    }
    assert(cliFailedAsExpected, 'CLI subprocess execution with --allowMockForTesting must exit with non-zero status');

    console.log('  PASSED: CLI execution strictly rejects allowMockForTesting and exits without writes.');
  }

  console.log('\nTest 22: Ordinary Programmatic Caller Cannot Enable Mock Writes Even When NODE_ENV=test (Programmatic Bypass Rejection)');
  {
    clearMigrationMockStore();
    const { runAdminMigrationRunner } = await import('../scripts/run-stage2a-migration');

    setMigrationMockDoc(`users/${userId}/riskConfig/config`, validLegacyConfig);

    // Call public runAdminMigrationRunner with allowMockForTesting when NODE_ENV is strictly 'test'
    assert(process.env.NODE_ENV === 'test', 'Test environment active');
    const res = await runAdminMigrationRunner({
      userId,
      accountId,
      tradingDate,
      now: testNow,
      confirmWrite: true,
      allowMockForTesting: true, // Ordinary programmatic bypass attempt
    } as any);

    assert(res.dryRun !== true, 'Executed in write mode attempt');
    if (!res.dryRun) {
      assert(res.success === false, 'Programmatic bypass attempt must fail closed');
      assert(
        res.errors !== undefined && res.errors[0].includes('PROGRAMMATIC_BYPASS_FORBIDDEN'),
        'Explicit PROGRAMMATIC_BYPASS_FORBIDDEN error returned'
      );
    }
    assert(
      getMigrationMockDoc(`users/${userId}/system/migrationState`) === undefined,
      'Zero writes: ordinary programmatic caller cannot write to mock store even when NODE_ENV=test'
    );

    console.log('  PASSED: Ordinary programmatic caller strictly blocked from mock writes even when NODE_ENV=test.');
  }

  console.log('\nTest 23: Isolated Test Token Security & Tamper Proofing');
  {
    clearMigrationMockStore();
    const {
      runAdminMigrationRunnerForIsolatedTesting,
      createIsolatedTestToken,
    } = await import('../scripts/run-stage2a-migration');

    // 23.1: Forged token (not minted by createIsolatedTestToken) fails closed
    const forgedToken = { id: 'forged_token', consumed: false } as any;
    const forgedRes = await runAdminMigrationRunnerForIsolatedTesting(
      {
        userId,
        accountId,
        tradingDate,
        now: testNow,
        confirmWrite: true,
      },
      forgedToken
    );
    assert(forgedRes.dryRun !== true, 'Executed in write mode');
    if (!forgedRes.dryRun) {
      assert(forgedRes.success === false, 'Forged token must fail closed');
      assert(
        forgedRes.errors !== undefined && forgedRes.errors[0].includes('INVALID_TEST_TOKEN'),
        'INVALID_TEST_TOKEN error returned'
      );
    }

    // 23.2: Reused token fails closed (single-use burned)
    setMigrationMockDoc(`users/${userId}/riskConfig/config`, validLegacyConfig);
    const validToken = createIsolatedTestToken();
    const firstRun = await runAdminMigrationRunnerForIsolatedTesting(
      {
        userId,
        accountId,
        tradingDate,
        now: testNow,
        confirmWrite: true,
        backupDir: './test_backups',
      },
      validToken
    );
    // Attempt to tamper with the token's exposed fields to bypass replay guard
    try {
      (validToken as any).consumed = false;
      (validToken as any).id = 'new_tampered_id';
    } catch {
      // In strict mode Object.freeze throws, which also prevents mutation
    }

    // Attempt reuse of same token after tampering
    const reusedRun = await runAdminMigrationRunnerForIsolatedTesting(
      {
        userId,
        accountId,
        tradingDate,
        now: testNow,
        confirmWrite: true,
      },
      validToken
    );
    assert(!reusedRun.dryRun && (reusedRun as any).success === false, 'Reused token must fail closed even after tampering');
    assert(
      !reusedRun.dryRun && (reusedRun as any).errors !== undefined && (reusedRun as any).errors[0].includes('TOKEN_ALREADY_CONSUMED'),
      'TOKEN_ALREADY_CONSUMED error returned on replayed token'
    );

    // 23.3: Cloned token object fails closed (not in issued WeakSet)
    const clonedToken = { ...validToken } as any;
    const clonedRun = await runAdminMigrationRunnerForIsolatedTesting(
      {
        userId,
        accountId,
        tradingDate,
        now: testNow,
        confirmWrite: true,
      },
      clonedToken
    );
    assert(!clonedRun.dryRun && (clonedRun as any).success === false, 'Cloned token must fail closed');
    assert(
      !clonedRun.dryRun && (clonedRun as any).errors !== undefined && (clonedRun as any).errors[0].includes('INVALID_TEST_TOKEN'),
      'INVALID_TEST_TOKEN error returned on cloned token'
    );

    // 23.4: Cannot mint test token in production
    const origEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    let mintFailed = false;
    try {
      createIsolatedTestToken();
    } catch (e: any) {
      mintFailed = true;
      assert(e.message.includes('ISOLATED_TEST_TOKEN_FORBIDDEN'), 'Error mentions ISOLATED_TEST_TOKEN_FORBIDDEN');
    } finally {
      process.env.NODE_ENV = origEnv;
    }
    assert(mintFailed, 'Cannot mint test token in production environment');

    // 23.5: Legitimate indirect call through test helper within /tests/ succeeds
    async function testHelperRunner(opts: any) {
      const helperToken = createIsolatedTestToken();
      return runAdminMigrationRunnerForIsolatedTesting(opts, helperToken);
    }
    const helperRes = await testHelperRunner({
      userId,
      accountId,
      tradingDate,
      now: testNow,
      confirmWrite: true,
      backupDir: './test_backups',
    });
    assert(!helperRes.dryRun && (helperRes as any).success === true, 'Indirect call through test helper within /tests/ succeeds');

    // 23.6: Non-test caller outside /tests/ strictly rejected
    const { execSync } = await import('child_process');
    let nonTestCallerRejected = false;
    try {
      execSync(
        `npx tsx -e "import { createIsolatedTestToken } from './scripts/run-stage2a-migration'; process.env.NODE_ENV = 'test'; createIsolatedTestToken();"`,
        { stdio: 'pipe' }
      );
    } catch (err: any) {
      nonTestCallerRejected = true;
      const stderr = err.stderr ? err.stderr.toString() : '';
      assert(
        stderr.includes('ISOLATED_TEST_TOKEN_FORBIDDEN') && stderr.includes('Immediate caller must be in /tests/'),
        'Non-test caller rejected by immediate caller stack check'
      );
    }
    assert(nonTestCallerRejected, 'Calling createIsolatedTestToken from outside /tests/ must fail closed');

    console.log('  PASSED: Isolated test token security (forgery, single-use, production blocking, helper delegation, and non-test rejection) verified.');
  }

  console.log('\n=== ALL STAGE 2A SAFETY CORRECTION & ADMIN RUNNER TESTS PASSED SUCCESSFULLY ===');
}

runStage2aSafetyCorrectionTests()
  .catch((err) => {
    console.error('\nSTAGE 2A SAFETY CORRECTION TESTS FAILED:', err);
    process.exit(1);
  })
  .finally(() => {
    cleanupTestBackups();
  });
