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

async function runStage2aCorrectionTests() {
  console.log('=== RUNNING STAGE 2A CORRECTION PASS TESTS ===\n');

  const userId = 'user_correction_test';
  const accountId = 'acc_mt_zerodha_default';
  const tradingDate = '2026-10-12';
  const testNow = new Date('2026-10-12T10:00:00.000Z');

  // --------------------------------------------------------------------------
  // SECTION 1: Lock Expiry Semantics
  // --------------------------------------------------------------------------
  console.log('Section 1: Lock Expiry Semantics (Future, Expired, Missing/Null, Invalid)');
  {
    // 1.1 Future lockUntil -> Active
    const futureSession = {
      tradingDate,
      userId,
      state: 'LOCKED' as const,
      isBreached: true,
      lockedAt: '2026-10-12T09:00:00.000Z',
      lockUntil: '2026-10-12T12:00:00.000Z', // Future relative to 10:00:00
      currentPnl: -10000,
      realisedPnl: -10000,
      unrealisedPnl: 0,
      lossLimit: 10000,
      warningThreshold1: 70,
      warningThreshold2: 90,
      lastEvaluatedAt: '2026-10-12T09:00:00.000Z',
      reason: 'Breached',
    };
    assert(checkIsLockActive(futureSession, testNow) === true, 'Future lockUntil must be active');

    // 1.2 Expired lockUntil -> Inactive
    const expiredSession = {
      ...futureSession,
      lockUntil: '2026-10-12T08:00:00.000Z', // Expired relative to 10:00:00
    };
    assert(checkIsLockActive(expiredSession, testNow) === false, 'Expired lockUntil must be inactive');

    // 1.3 Missing / Null lockUntil -> Indefinite Active Lock
    const nullLockSession = {
      ...futureSession,
      lockUntil: null,
    };
    assert(
      checkIsLockActive(nullLockSession, testNow) === true,
      'Null lockUntil must be active (indefinite lock)'
    );

    const undefinedLockSession = {
      ...futureSession,
      lockUntil: undefined as any,
    };
    assert(
      checkIsLockActive(undefinedLockSession, testNow) === true,
      'Undefined lockUntil must be active (indefinite lock)'
    );

    // 1.4 Invalid non-null string lockUntil -> Inactive
    const invalidLockSession = {
      ...futureSession,
      lockUntil: 'invalid-date-string-xyz',
    };
    assert(
      checkIsLockActive(invalidLockSession, testNow) === false,
      'Invalid non-null lockUntil must NOT be treated as active'
    );

    // 1.5 Matching tradingDate -> Active
    assert(
      checkIsLockActive(futureSession, testNow, '2026-10-12') === true,
      'Matching tradingDate must be active'
    );

    // 1.6 Mismatched tradingDate -> Inactive
    assert(
      checkIsLockActive(futureSession, testNow, '2026-10-13') === false,
      'Mismatched tradingDate must NOT be treated as active'
    );

    // 1.7 Missing session tradingDate -> Inactive when expectedTradingDate is supplied
    const missingDateSession = {
      ...futureSession,
      tradingDate: undefined as any,
    };
    assert(
      checkIsLockActive(missingDateSession, testNow, '2026-10-12') === false,
      'Missing session tradingDate must be inactive when expectedTradingDate is supplied'
    );
    assert(
      checkIsLockActive(missingDateSession, testNow) === true,
      'Missing session tradingDate remains active when no expected date is supplied'
    );

    // 1.8 Mismatched legacy session in evaluateLockMirroring -> NOT mirrored
    const mismatchedLegacySession = {
      ...futureSession,
      tradingDate: '2026-10-11', // Mismatched date
    };
    const mirrorEvalRes = evaluateLockMirroring(
      mismatchedLegacySession,
      null,
      userId,
      accountId,
      '2026-10-12', // Target date being migrated
      DEFAULT_RISK_CONFIG,
      testNow
    );
    assert(
      mirrorEvalRes.shouldMirror === false,
      'Mismatched legacy session date must NOT be mirrored'
    );

    // 1.9 Missing date legacy session in evaluateLockMirroring -> NOT mirrored
    const missingDateLegacySession = {
      ...futureSession,
      tradingDate: undefined as any,
    };
    const missingDateMirrorRes = evaluateLockMirroring(
      missingDateLegacySession,
      null,
      userId,
      accountId,
      '2026-10-12',
      DEFAULT_RISK_CONFIG,
      testNow
    );
    assert(
      missingDateMirrorRes.shouldMirror === false,
      'Legacy session with missing tradingDate must NOT be mirrored when target date is supplied'
    );

    console.log('  PASSED: All 9 lock expiry & strict date matching conditions verified.');
  }

  // --------------------------------------------------------------------------
  // SECTION 2: Session Mirroring Fidelity & Immutability
  // --------------------------------------------------------------------------
  console.log('\nSection 2: Session Mirroring Fidelity & Legacy Immutability');
  {
    clearMigrationMockStore();

    const customLegacySession = {
      tradingDate,
      userId,
      state: 'LOCKED' as const,
      isBreached: true,
      lockedAt: '2026-10-12T08:30:00.000Z',
      lockUntil: '2026-10-12T14:30:00.000Z',
      customTraderNote: 'Special audit tag',
      // Note: currentPnl and reason intentionally left undefined to test zero-fabrication
    };

    const legacyPath = `users/${userId}/riskSessions/${tradingDate}`;
    setMigrationMockDoc(legacyPath, customLegacySession);

    const result = await migrateUserRiskData(userId, accountId, tradingDate, testNow);
    assert(result.success === true, 'Migration should succeed');
    assert(result.sessionMirrored === true, 'Session should be mirrored');

    const accountSessionPath = `users/${userId}/accountRiskSessions/${accountId}__${tradingDate}`;
    const mirrored = getMigrationMockDoc(accountSessionPath);

    // Verify exact field fidelity
    assert(mirrored !== null, 'Mirrored doc created');
    assert(mirrored.customTraderNote === 'Special audit tag', 'Custom field preserved verbatim');
    assert(mirrored.lockedAt === '2026-10-12T08:30:00.000Z', 'lockedAt preserved verbatim');
    assert(mirrored.lockUntil === '2026-10-12T14:30:00.000Z', 'lockUntil preserved verbatim');
    assert(mirrored.accountId === accountId, 'accountId added');
    assert(mirrored.updatedAt === testNow.toISOString(), 'updatedAt set to now ISO string');

    // Confirm no fabricated values were added
    assert(mirrored.currentPnl === undefined, 'currentPnl must NOT be fabricated if absent');
    assert(mirrored.reason === undefined, 'reason must NOT be fabricated if absent');

    // Verify legacy document immutability
    const legacyAfter = getMigrationMockDoc(legacyPath);
    assert(
      JSON.stringify(legacyAfter) === JSON.stringify(customLegacySession),
      'Legacy riskSessions document MUST NOT be modified or written to'
    );

    console.log('  PASSED: Exact field fidelity verified and legacy doc kept untouched.');
  }

  // --------------------------------------------------------------------------
  // SECTION 3: Loss Limit Alias Resolution
  // --------------------------------------------------------------------------
  console.log('\nSection 3: Loss-Limit Alias Resolution');
  {
    // 3.1 Valid dailyLossLimit takes priority over valid maxLoss
    const bothValid = { dailyLossLimit: 15000, maxLoss: 5000 };
    assert(resolveLossLimit(bothValid) === 15000, 'Valid dailyLossLimit takes priority');

    // 3.2 Malformed dailyLossLimit combined with valid maxLoss -> maxLoss selected
    const malformedDailyLimit = { dailyLossLimit: -100, maxLoss: 7500 };
    assert(resolveLossLimit(malformedDailyLimit) === 7500, 'Valid maxLoss fallback selected');

    const stringDailyLimit = { dailyLossLimit: '10000' as any, maxLoss: 8000 };
    assert(resolveLossLimit(stringDailyLimit) === 8000, 'Valid maxLoss fallback selected');

    // 3.3 Invalid dailyLossLimit & invalid maxLoss -> default limit (10000) selected
    const bothInvalid = { dailyLossLimit: 250, maxLoss: 300 }; // Both below ₹500
    assert(
      resolveLossLimit(bothInvalid) === DEFAULT_RISK_CONFIG.dailyLossLimit,
      'Default limit selected when both limits are invalid'
    );

    // 3.4 Strict numeric constraints (>= 500 and % 500 === 0)
    assert(isValidLossLimit(500) === true, '₹500 is valid');
    assert(isValidLossLimit(10000) === true, '₹10000 is valid');
    assert(isValidLossLimit(499) === false, '₹499 is invalid (< 500)');
    assert(isValidLossLimit(1200) === false, '1200 is invalid (not % 500)');
    assert(isValidLossLimit(NaN) === false, 'NaN is invalid');
    assert(isValidLossLimit(Infinity) === false, 'Infinity is invalid');

    console.log('  PASSED: Loss limit alias resolution & numeric constraints verified.');
  }

  // --------------------------------------------------------------------------
  // SECTION 4: Timestamp Reconciliation
  // --------------------------------------------------------------------------
  console.log('\nSection 4: Timestamp Reconciliation');
  {
    // 4.1 Legacy newer -> Legacy wins
    const legacyNewer = {
      dailyLossLimit: 15000,
      warningThreshold1: 70,
      warningThreshold2: 90,
      lockDurationMinutes: 720,
      updatedAt: '2026-10-12T10:00:00.000Z',
    };
    const accountOlder = {
      dailyLossLimit: 10000,
      warningThreshold1: 70,
      warningThreshold2: 90,
      lockDurationMinutes: 720,
      updatedAt: '2026-10-12T09:00:00.000Z',
    };
    const res1 = reconcileRiskConfigs(legacyNewer, accountOlder, testNow);
    assert(res1.reconciledConfig?.dailyLossLimit === 15000, 'Legacy newer timestamp wins');

    // 4.2 Account newer -> Account wins
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
    assert(res2.reconciledConfig?.dailyLossLimit === 20000, 'Account newer timestamp wins');

    // 4.3 Equal timestamps -> Account wins
    const legacyEqual = {
      dailyLossLimit: 15000,
      warningThreshold1: 70,
      warningThreshold2: 90,
      lockDurationMinutes: 720,
      updatedAt: '2026-10-12T09:00:00.000Z',
    };
    const accountEqual = {
      dailyLossLimit: 25000,
      warningThreshold1: 70,
      warningThreshold2: 90,
      lockDurationMinutes: 720,
      updatedAt: '2026-10-12T09:00:00.000Z',
    };
    const res3 = reconcileRiskConfigs(legacyEqual, accountEqual, testNow);
    assert(res3.reconciledConfig?.dailyLossLimit === 25000, 'Account wins on equal timestamps');

    // 4.4 Legacy timestamp valid, Account timestamp missing/invalid -> Legacy wins
    const legacyValidTime = {
      dailyLossLimit: 12000,
      warningThreshold1: 70,
      warningThreshold2: 90,
      lockDurationMinutes: 720,
      updatedAt: '2026-10-12T09:00:00.000Z',
    };
    const accountMissingTime = {
      dailyLossLimit: 8000,
      warningThreshold1: 70,
      warningThreshold2: 90,
      lockDurationMinutes: 720,
    };
    const res4 = reconcileRiskConfigs(legacyValidTime, accountMissingTime, testNow);
    assert(res4.reconciledConfig?.dailyLossLimit === 12000, 'Valid legacy timestamp wins over missing');

    // 4.5 Account timestamp valid, Legacy timestamp missing/invalid -> Account wins
    const legacyInvalidTime = {
      dailyLossLimit: 12000,
      warningThreshold1: 70,
      warningThreshold2: 90,
      lockDurationMinutes: 720,
      updatedAt: 'invalid-date',
    };
    const accountValidTime = {
      dailyLossLimit: 18000,
      warningThreshold1: 70,
      warningThreshold2: 90,
      lockDurationMinutes: 720,
      updatedAt: '2026-10-12T09:00:00.000Z',
    };
    const res5 = reconcileRiskConfigs(legacyInvalidTime, accountValidTime, testNow);
    assert(res5.reconciledConfig?.dailyLossLimit === 18000, 'Valid account timestamp wins over invalid');

    // 4.6 Both timestamps missing/invalid -> Account wins
    const legacyNoTime = {
      dailyLossLimit: 12000,
      warningThreshold1: 70,
      warningThreshold2: 90,
      lockDurationMinutes: 720,
    };
    const accountNoTime = {
      dailyLossLimit: 22000,
      warningThreshold1: 70,
      warningThreshold2: 90,
      lockDurationMinutes: 720,
    };
    const res6 = reconcileRiskConfigs(legacyNoTime, accountNoTime, testNow);
    assert(res6.reconciledConfig?.dailyLossLimit === 22000, 'Account wins when both timestamps missing');

    console.log('  PASSED: All 6 timestamp reconciliation cases verified.');
  }

  // --------------------------------------------------------------------------
  // SECTION 5: Transaction Atomicity, Rollback & Idempotency
  // --------------------------------------------------------------------------
  console.log('\nSection 5: Transaction Atomicity, Rollback & Idempotency Coverage');
  {
    clearMigrationMockStore();

    // Set initial doc state before failed transaction attempt
    const initialLegacyConfig = { dailyLossLimit: 10000, updatedAt: '2026-10-11T12:00:00.000Z' };
    setMigrationMockDoc(`users/${userId}/riskConfig/config`, initialLegacyConfig);

    // Inject transaction failure
    setMockTransactionFailureInjector(() => {
      throw new Error('SIMULATED_FIRESTORE_WRITE_FAILURE');
    });

    const failedResult = await migrateUserRiskData(userId, accountId, tradingDate, testNow);
    assert(failedResult.success === false, 'Transaction must report success: false on failure');
    assert(failedResult.schemaVersion === 0, 'schemaVersion must remain 0 on failure');

    // Verify atomic failure behavior: schemaVersion 2 MUST NOT be set
    const metaDoc = getMigrationMockDoc(`users/${userId}/system/migrationState`);
    assert(metaDoc === undefined, 'migrationState schemaVersion 2 MUST NOT be set on transaction failure');

    // Verify no partial writes occurred
    const accConfigDoc = getMigrationMockDoc(`users/${userId}/accountRiskConfigs/${accountId}`);
    assert(accConfigDoc === undefined, 'No partial accountRiskConfig write must occur on failure');

    // Clear failure injector for successful run
    setMockTransactionFailureInjector(null);

    // Successful execution
    const run1 = await migrateUserRiskData(userId, accountId, tradingDate, testNow);
    assert(run1.success === true && run1.skipped === false, 'Run 1 must succeed and execute writes');
    assert(run1.schemaVersion === 2, 'Run 1 sets schemaVersion = 2');

    const metaAfterRun1 = getMigrationMockDoc(`users/${userId}/system/migrationState`);
    assert(metaAfterRun1 && metaAfterRun1.schemaVersion === 2, 'schemaVersion 2 written to migrationState');

    // Idempotent second execution
    const run2 = await migrateUserRiskData(userId, accountId, tradingDate, testNow);
    assert(run2.success === true, 'Run 2 must succeed');
    assert(run2.skipped === true, 'Run 2 must skip with zero writes');
    assert(run2.schemaVersion === 2, 'Run 2 reports schemaVersion = 2');

    console.log('  PASSED: Atomic transaction failure rollback & zero-write idempotency verified.');
  }

  console.log('\n=== ALL STAGE 2A CORRECTION PASS TESTS PASSED SUCCESSFULLY ===');
}

runStage2aCorrectionTests().catch((err) => {
  console.error('\nSTAGE 2A CORRECTION PASS TESTS FAILED:', err);
  process.exit(1);
});
