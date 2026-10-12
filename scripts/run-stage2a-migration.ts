import fs from 'fs';
import path from 'path';
import { getAdminFirestore, isMockStoreEnabled } from '../server/brokers/zerodha/sessionStore';
import {
  migrateUserRiskData,
  reconcileRiskConfigs,
  evaluateLockMirroring,
  getMigrationMockDoc,
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
 * Creates and verifies a 5-document pre-migration snapshot backup.
 * Includes absent-document markers (`exists: false`, `data: null`).
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
  const docs: DocumentBackupEntry[] = [];

  for (const docPath of paths) {
    if (adminDb && !isMock) {
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
    } else {
      const mockData = getMigrationMockDoc(docPath);
      docs.push({
        path: docPath,
        exists: mockData !== undefined && mockData !== null,
        data: mockData !== undefined && mockData !== null ? JSON.parse(JSON.stringify(mockData)) : null,
      });
    }
  }

  const backup: MigrationBackup = {
    userId,
    accountId,
    tradingDate,
    createdAt: new Date().toISOString(),
    documents: docs,
  };

  // Verify backup payload completeness
  if (backup.documents.length !== 5) {
    return { success: false, error: `BACKUP_VERIFICATION_FAILED: Expected 5 documents in backup, got ${backup.documents.length}` };
  }

  for (const entry of backup.documents) {
    if (!entry.path || typeof entry.exists !== 'boolean') {
      return { success: false, error: `BACKUP_VERIFICATION_FAILED: Malformed document entry for ${entry.path}` };
    }
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

    if (!reloaded || reloaded.documents.length !== 5) {
      return { success: false, error: 'BACKUP_VERIFICATION_FAILED: Reloaded backup on disk is incomplete or corrupted.' };
    }

    return { success: true, backupPath: filePath, backup: reloaded };
  } catch (fsErr: any) {
    return { success: false, error: `BACKUP_FILE_SAVE_ERROR: ${fsErr?.message || String(fsErr)}` };
  }
}

/**
 * Stage 2A Administrative Migration Runner
 */
export async function runAdminMigrationRunner(options: AdminRunnerOptions): Promise<AdminRunnerResult> {
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

  // 2. DRY-RUN PASS (Default mode)
  if (!isWriteMode) {
    const adminDb = getAdminFirestore();
    const isMock = isMockStoreEnabled();

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

    const { reconciledConfig, errors: configErrors } = reconcileRiskConfigs(legacyRaw, accountRaw, now);
    if (!reconciledConfig) {
      return {
        dryRun: true,
        valid: false,
        errors: configErrors || ['Configuration reconciliation failed.'],
      };
    }

    const mirrorResult = evaluateLockMirroring(
      legacySession,
      existingAccountSession,
      cleanUserId,
      accountId,
      effectiveTradingDate,
      reconciledConfig,
      now
    );

    if (!mirrorResult.valid) {
      return {
        dryRun: true,
        valid: false,
        reconciledConfig,
        errors: [mirrorResult.error || 'Legacy session date validation failed.'],
      };
    }

    return {
      dryRun: true,
      valid: true,
      reconciledConfig,
      shouldMirror: mirrorResult.shouldMirror,
      mirroredSession: mirrorResult.mirroredSession,
    };
  }

  // Store Mode Safeguard: Verify requested store mode aligns with active environment store mode
  if (options.useMockStore !== undefined && options.useMockStore !== isMockStoreEnabled()) {
    throw new Error(
      `STORE_MODE_MISMATCH: Requested useMockStore=${options.useMockStore} but active system store mode is isMockStoreEnabled()=${isMockStoreEnabled()}. Execution blocked to prevent routing mismatch.`
    );
  }

  // 3. WRITE MODE (Requires Backup Verification First)
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

  // Execute existing migration function directly, passing expectedBackup to enforce post-backup staleness guard
  const migrationRes = await migrateUserRiskData(cleanUserId, accountId, effectiveTradingDate, now, backupRes.backup);

  return {
    ...migrationRes,
    dryRun: false,
    backupPath: backupRes.backupPath,
  };
}

import { fileURLToPath } from 'url';

// CLI entry point execution when run directly via tsx (guarded against module import)
if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const options: AdminRunnerOptions = {};

  for (const arg of args) {
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
