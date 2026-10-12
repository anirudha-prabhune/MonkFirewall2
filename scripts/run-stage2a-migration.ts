import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getAdminFirestore, isMockStoreEnabled } from '../server/brokers/zerodha/sessionStore';
import {
  migrateUserRiskData,
  reconcileRiskConfigs,
  evaluateLockMirroring,
  getMigrationMockDoc,
  verifyBackupPathIntegrity,
  MigrationResult,
} from '../server/risk/migration';
import { RiskSession, getTradingDateKolkata } from '../server/risk/engine';

export interface AdminRunnerOptions {
  userId?: string;
  accountId?: string;
  tradingDate?: string;
  confirmWrite?: boolean;
  dryRun?: boolean;
  useMockStore?: boolean;
  isCli?: boolean;
  now?: Date;
  backupDir?: string;
  failBackupForTest?: boolean;
}

export interface DocumentBackupEntry {
  path: string;
  exists: boolean;
  data: any | null;
}

export interface MigrationBackup {
  userId: string;
  accountId: string;
  tradingDate: string;
  createdAt: string;
  documents: DocumentBackupEntry[];
}

export interface DryRunResult {
  dryRun: true;
  valid: boolean;
  reconciledConfig?: any;
  shouldMirror?: boolean;
  mirroredSession?: any;
  errors?: string[];
}

export type AdminRunnerResult = (MigrationResult & { dryRun?: false; backupPath?: string }) | DryRunResult;

/**
 * Validates a YYYY-MM-DD date string for real calendar validity.
 */
export function isValidCalendarDate(dateStr?: string): boolean {
  if (!dateStr || typeof dateStr !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    return false;
  }
  const [year, month, day] = dateStr.split('-').map(Number);
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return false;
  }
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

/**
 * Creates and verifies a 5-document pre-migration snapshot backup from real Firestore.
 * Strictly requires real Firestore connection; rejects mock store mode.
 * Strictly verifies each of the exact five required paths is present exactly once.
 */
export async function createAndVerifyBackup(
  userId: string,
  accountId: string,
  tradingDate: string,
  backupDir = './backups',
  failBackupForTest = false
): Promise<{ success: boolean; backupPath?: string; backup?: MigrationBackup; error?: string }> {
  if (failBackupForTest) {
    return { success: false, error: 'INJECTED_BACKUP_FAILURE: Backup creation failed for testing.' };
  }

  const paths = [
    `users/${userId}/system/migrationState`,
    `users/${userId}/riskConfig/config`,
    `users/${userId}/accountRiskConfigs/${accountId}`,
    `users/${userId}/riskSessions/${tradingDate}`,
    `users/${userId}/accountRiskSessions/${accountId}__${tradingDate}`,
  ];

  const adminDb = getAdminFirestore();
  const isMock = isMockStoreEnabled();

  if (!adminDb || isMock) {
    return {
      success: false,
      error: 'REAL_FIRESTORE_REQUIRED: Real Firestore Admin SDK must be active and mock mode disabled to create a backup.',
    };
  }

  const docs: DocumentBackupEntry[] = [];

  for (const docPath of paths) {
    try {
      const snap = await adminDb.doc(docPath).get();
      docs.push({
        path: docPath,
        exists: snap.exists,
        data: snap.exists ? snap.data() : null,
      });
    } catch (err: any) {
      return { success: false, error: `FIRESTORE_BACKUP_READ_ERROR on ${docPath}: ${err?.message || String(err)}` };
    }
  }

  const backup: MigrationBackup = {
    userId,
    accountId,
    tradingDate,
    createdAt: new Date().toISOString(),
    documents: docs,
  };

  // Verify backup payload contains each of the exact 5 paths exactly once before saving
  const preCheck = verifyBackupPathIntegrity(backup.documents, paths);
  if (!preCheck.valid) {
    return { success: false, error: preCheck.error };
  }

  // Save backup artifact to disk
  const timestampStr = backup.createdAt.replace(/[:.]/g, '-');
  const fileName = `backup_${userId}_${accountId}_${tradingDate}_${timestampStr}.json`;
  const filePath = path.join(backupDir, fileName);

  try {
    if (!fs.existsSync(backupDir)) {
      fs.mkdirSync(backupDir, { recursive: true });
    }
    fs.writeFileSync(filePath, JSON.stringify(backup, null, 2), 'utf-8');

    // Re-read backup file from disk to verify integrity
    const fileContent = fs.readFileSync(filePath, 'utf-8');
    const reloaded = JSON.parse(fileContent) as MigrationBackup;

    if (!reloaded || !Array.isArray(reloaded.documents)) {
      return { success: false, error: 'BACKUP_VERIFICATION_FAILED: Reloaded backup on disk is incomplete or corrupted.' };
    }

    const postCheck = verifyBackupPathIntegrity(reloaded.documents, paths);
    if (!postCheck.valid) {
      return { success: false, error: postCheck.error };
    }

    return { success: true, backupPath: filePath, backup: reloaded };
  } catch (fsErr: any) {
    return { success: false, error: `BACKUP_FILE_SAVE_ERROR: ${fsErr?.message || String(fsErr)}` };
  }
}

/**
 * Stage 2A Administrative Migration Runner
 * Production/CLI runner entry point for administrative migration execution.
 * Strictly real-Firestore-only for writes. Mock write operations are strictly blocked.
 */
export async function runAdminMigrationRunner(options: AdminRunnerOptions): Promise<AdminRunnerResult> {
  // Reject any attempt to pass allowMockForTesting or similar bypass options
  if ((options as any).allowMockForTesting !== undefined) {
    return {
      success: false,
      schemaVersion: 0,
      errors: [
        'PROGRAMMATIC_BYPASS_FORBIDDEN: allowMockForTesting is not supported. Production migration runner does not support mock writes.',
      ],
    };
  }

  const now = options.now || new Date();

  // 1. Argument Validation
  if (!options.userId || !options.userId.trim()) {
    throw new Error('ARGUMENT_ERROR: --userId is required and must be a non-empty string.');
  }
  const cleanUserId = options.userId.trim();

  const accountId = (options.accountId && options.accountId.trim()) ? options.accountId.trim() : 'acc_mt_zerodha_default';

  const isWriteMode = options.confirmWrite === true && options.dryRun !== true;

  // In Write Mode: tradingDate MUST be explicitly supplied and must be a valid calendar date
  if (isWriteMode) {
    if (!options.tradingDate || !options.tradingDate.trim()) {
      throw new Error('ARGUMENT_ERROR: Write mode (--confirmWrite=true) requires an explicit --tradingDate.');
    }
    if (!isValidCalendarDate(options.tradingDate.trim())) {
      throw new Error(`ARGUMENT_ERROR: Invalid calendar date '${options.tradingDate}' supplied for --tradingDate.`);
    }
  } else {
    // In Dry-Run Mode: If tradingDate supplied, validate format; if omitted, default to Kolkata date
    if (options.tradingDate && !isValidCalendarDate(options.tradingDate.trim())) {
      throw new Error(`ARGUMENT_ERROR: Invalid calendar date '${options.tradingDate}' supplied for --tradingDate.`);
    }
  }

  const effectiveTradingDate = options.tradingDate ? options.tradingDate.trim() : getTradingDateKolkata(now);

  const adminDb = getAdminFirestore();
  const isMock = isMockStoreEnabled();

  // Store Mode Safeguard: Verify requested store mode aligns with active environment store mode
  if (options.useMockStore !== undefined && options.useMockStore !== isMock) {
    throw new Error(
      `STORE_MODE_MISMATCH: Requested useMockStore=${options.useMockStore} but active system store mode is isMockStoreEnabled()=${isMock}. Execution blocked to prevent routing mismatch.`
    );
  }

  // Fail-Closed Store Guard:
  // In write mode, require real Firestore to be initialized and mock mode to be disabled.
  // Never silently fall back to mock storage.
  if (isWriteMode) {
    if (isMock) {
      return {
        success: false,
        schemaVersion: 0,
        errors: [
          'REAL_FIRESTORE_REQUIRED: Write mode requires mock store to be disabled (isMockStoreEnabled() === false). Mock store execution in write mode is strictly blocked in production.',
        ],
      };
    }

    if (!adminDb) {
      return {
        success: false,
        schemaVersion: 0,
        errors: [
          'REAL_FIRESTORE_REQUIRED: Real Firestore Admin SDK is not initialized. Write mode cannot proceed without an active Firestore connection.',
        ],
      };
    }
  }

  // 2. DRY-RUN PASS (Default mode)
  if (!isWriteMode) {
    let legacyRaw: any = null;
    let accountRaw: any = null;
    let legacySession: RiskSession | null = null;
    let existingAccountSession: RiskSession | null = null;

    const legacyConfigDocPath = `users/${cleanUserId}/riskConfig/config`;
    const accountConfigDocPath = `users/${cleanUserId}/accountRiskConfigs/${accountId}`;
    const legacySessionDocPath = `users/${cleanUserId}/riskSessions/${effectiveTradingDate}`;
    const accountSessionDocPath = `users/${cleanUserId}/accountRiskSessions/${accountId}__${effectiveTradingDate}`;

    if (adminDb && !isMock) {
      const [legacyConfigSnap, accountConfigSnap, legacySessionSnap, accountSessionSnap] = await Promise.all([
        adminDb.doc(legacyConfigDocPath).get(),
        adminDb.doc(accountConfigDocPath).get(),
        adminDb.doc(legacySessionDocPath).get(),
        adminDb.doc(accountSessionDocPath).get(),
      ]);

      legacyRaw = legacyConfigSnap.exists ? legacyConfigSnap.data() : null;
      accountRaw = accountConfigSnap.exists ? accountConfigSnap.data() : null;
      legacySession = legacySessionSnap.exists ? (legacySessionSnap.data() as RiskSession) : null;
      existingAccountSession = accountSessionSnap.exists ? (accountSessionSnap.data() as RiskSession) : null;
    } else {
      legacyRaw = getMigrationMockDoc(legacyConfigDocPath) || null;
      accountRaw = getMigrationMockDoc(accountConfigDocPath) || null;
      legacySession = getMigrationMockDoc(legacySessionDocPath) || null;
      existingAccountSession = getMigrationMockDoc(accountSessionDocPath) || null;
    }

    const configResult = reconcileRiskConfigs(legacyRaw, accountRaw, now);
    if (!configResult.reconciledConfig) {
      return {
        dryRun: true,
        valid: false,
        errors: configResult.errors || ['Both legacy and account configs are missing or invalid.'],
      };
    }

    const lockResult = evaluateLockMirroring(
      legacySession,
      existingAccountSession,
      cleanUserId,
      accountId,
      effectiveTradingDate,
      configResult.reconciledConfig,
      now
    );
    if (!lockResult.valid) {
      return {
        dryRun: true,
        valid: false,
        reconciledConfig: configResult.reconciledConfig,
        errors: [`LOCK_MIRRORING_FAILED: ${lockResult.error}`],
      };
    }

    return {
      dryRun: true,
      valid: true,
      reconciledConfig: configResult.reconciledConfig,
      shouldMirror: lockResult.shouldMirror,
      mirroredSession: lockResult.mirroredSession,
    };
  }

  // 3. WRITE MODE (Requires Real Firestore Backup Verification First)
  const backupRes = await createAndVerifyBackup(
    cleanUserId,
    accountId,
    effectiveTradingDate,
    options.backupDir || './backups',
    options.failBackupForTest || false
  );

  if (!backupRes.success || !backupRes.backupPath) {
    return {
      success: false,
      schemaVersion: 0,
      errors: [`BACKUP_VERIFICATION_FAILED: ${backupRes.error || 'Failed to create and verify pre-migration backup.'}`],
    };
  }

  // Execute migration directly, passing expectedBackup to enforce post-backup staleness guard
  const migrationRes = await migrateUserRiskData(cleanUserId, accountId, effectiveTradingDate, now, backupRes.backup);

  return {
    ...migrationRes,
    dryRun: false,
    backupPath: backupRes.backupPath,
  };
}

// CLI entry point execution when run directly via tsx (guarded against module import)
if (
  process.argv[1] &&
  (process.argv[1] === fileURLToPath(import.meta.url) ||
    process.argv[1].endsWith('run-stage2a-migration.ts') ||
    process.argv[1].endsWith('run-stage2a-migration'))
) {
  const args = process.argv.slice(2);
  const options: AdminRunnerOptions = { isCli: true };

  for (const arg of args) {
    if (arg.startsWith('--allowMockForTesting') || arg.startsWith('--allowMock') || arg.startsWith('--useMock')) {
      console.error(`CLI_ERROR: Mock testing flags (${arg}) are strictly forbidden in CLI execution.`);
      process.exit(1);
    }
    if (arg.startsWith('--userId=')) options.userId = arg.split('=')[1];
    if (arg.startsWith('--accountId=')) options.accountId = arg.split('=')[1];
    if (arg.startsWith('--tradingDate=')) options.tradingDate = arg.split('=')[1];
    if (arg === '--confirmWrite=true' || arg === '--confirmWrite') options.confirmWrite = true;
    if (arg === '--dryRun') options.dryRun = true;
  }

  runAdminMigrationRunner(options)
    .then((res) => {
      console.log('Stage 2A Migration Runner Result:', JSON.stringify(res, null, 2));
      process.exit(res.dryRun ? (res.valid ? 0 : 1) : (res.success ? 0 : 1));
    })
    .catch((err) => {
      console.error('Stage 2A Migration Runner Error:', err.message || err);
      process.exit(1);
    });
}
