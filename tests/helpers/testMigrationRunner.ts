import fs from 'fs';
import path from 'path';
import {
  migrateUserRiskData,
  reconcileRiskConfigs,
  evaluateLockMirroring,
  getMigrationMockDoc,
  verifyBackupPathIntegrity,
  MigrationResult,
} from '../../server/risk/migration';
import { RiskSession, getTradingDateKolkata } from '../../server/risk/engine';

export interface TestMigrationRunnerOptions {
  userId?: string;
  accountId?: string;
  tradingDate?: string;
  confirmWrite?: boolean;
  dryRun?: boolean;
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

export interface TestDryRunResult {
  dryRun: true;
  valid: boolean;
  reconciledConfig?: any;
  shouldMirror?: boolean;
  mirroredSession?: any;
  errors?: string[];
}

export type TestMigrationRunnerResult =
  | (MigrationResult & { dryRun: false; backupPath?: string })
  | TestDryRunResult;

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
 * Creates and verifies a 5-document pre-migration snapshot backup using the in-memory mock store.
 * Isolated test harness helper for verifying migration backup and stale-guard integrity.
 */
export async function createAndVerifyMockBackup(
  userId: string,
  accountId: string,
  tradingDate: string,
  backupDir = './test_backups',
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

  const docs: DocumentBackupEntry[] = [];

  for (const docPath of paths) {
    const mockData = getMigrationMockDoc(docPath);
    docs.push({
      path: docPath,
      exists: mockData !== undefined && mockData !== null,
      data: mockData !== undefined && mockData !== null ? JSON.parse(JSON.stringify(mockData)) : null,
    });
  }

  const backup: MigrationBackup = {
    userId,
    accountId,
    tradingDate,
    createdAt: new Date().toISOString(),
    documents: docs,
  };

  const preCheck = verifyBackupPathIntegrity(backup.documents, paths);
  if (!preCheck.valid) {
    return { success: false, error: preCheck.error };
  }

  const timestampStr = backup.createdAt.replace(/[:.]/g, '-');
  const fileName = `backup_${userId}_${accountId}_${tradingDate}_${timestampStr}.json`;
  const filePath = path.join(backupDir, fileName);

  try {
    if (!fs.existsSync(backupDir)) {
      fs.mkdirSync(backupDir, { recursive: true });
    }
    fs.writeFileSync(filePath, JSON.stringify(backup, null, 2), 'utf-8');

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
 * Isolated Test Migration Harness
 *
 * Dedicated test runner for executing Stage 2A migration lifecycle tests against mock storage.
 * Structurally isolated under tests/helpers/ so that production application and CLI code
 * cannot invoke it or be contaminated by mock-write capabilities.
 */
export async function runStage2aMigrationTestHarness(
  options: TestMigrationRunnerOptions
): Promise<TestMigrationRunnerResult> {
  const now = options.now || new Date();

  // 1. Argument Validation
  if (!options.userId || !options.userId.trim()) {
    throw new Error('ARGUMENT_ERROR: --userId is required and must be a non-empty string.');
  }
  const cleanUserId = options.userId.trim();
  const accountId = (options.accountId && options.accountId.trim()) ? options.accountId.trim() : 'acc_mt_zerodha_default';
  const isWriteMode = options.confirmWrite === true && options.dryRun !== true;

  if (isWriteMode) {
    if (!options.tradingDate || !options.tradingDate.trim()) {
      throw new Error('ARGUMENT_ERROR: Write mode (--confirmWrite=true) requires an explicit --tradingDate.');
    }
    if (!isValidCalendarDate(options.tradingDate.trim())) {
      throw new Error(`ARGUMENT_ERROR: Invalid calendar date '${options.tradingDate}' supplied for --tradingDate.`);
    }
  } else {
    if (options.tradingDate && !isValidCalendarDate(options.tradingDate.trim())) {
      throw new Error(`ARGUMENT_ERROR: Invalid calendar date '${options.tradingDate}' supplied for --tradingDate.`);
    }
  }

  const effectiveTradingDate = options.tradingDate ? options.tradingDate.trim() : getTradingDateKolkata(now);

  // 2. DRY-RUN PASS
  if (!isWriteMode) {
    const legacyConfigDocPath = `users/${cleanUserId}/riskConfig/config`;
    const accountConfigDocPath = `users/${cleanUserId}/accountRiskConfigs/${accountId}`;
    const legacySessionDocPath = `users/${cleanUserId}/riskSessions/${effectiveTradingDate}`;
    const accountSessionDocPath = `users/${cleanUserId}/accountRiskSessions/${accountId}__${effectiveTradingDate}`;

    const legacyRaw = getMigrationMockDoc(legacyConfigDocPath) || null;
    const accountRaw = getMigrationMockDoc(accountConfigDocPath) || null;
    const legacySession: RiskSession | null = getMigrationMockDoc(legacySessionDocPath) || null;
    const existingAccountSession: RiskSession | null = getMigrationMockDoc(accountSessionDocPath) || null;

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

  // 3. WRITE PASS (with mock backup and atomic transactional stale-guard check)
  const backupRes = await createAndVerifyMockBackup(
    cleanUserId,
    accountId,
    effectiveTradingDate,
    options.backupDir || './test_backups',
    options.failBackupForTest || false
  );

  if (!backupRes.success || !backupRes.backupPath) {
    return {
      success: false,
      schemaVersion: 0,
      dryRun: false,
      errors: [`BACKUP_VERIFICATION_FAILED: ${backupRes.error || 'Failed to create and verify pre-migration backup.'}`],
    };
  }

  const migrationRes = await migrateUserRiskData(cleanUserId, accountId, effectiveTradingDate, now, backupRes.backup);

  return {
    ...migrationRes,
    dryRun: false,
    backupPath: backupRes.backupPath,
  };
}
