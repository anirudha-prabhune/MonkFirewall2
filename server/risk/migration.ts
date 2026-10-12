import { getAdminFirestore, isMockStoreEnabled } from '../brokers/zerodha/sessionStore';
import { RiskConfig, DEFAULT_RISK_CONFIG } from '../../src/types/risk';
import { validateRiskConfig } from './validation';
import { RiskSession, getTradingDateKolkata } from './engine';

export interface MigrationResult {
  success: boolean;
  skipped?: boolean;
  schemaVersion: number;
  migratedAt?: string;
  reconciledConfig?: RiskConfig;
  sessionMirrored?: boolean;
  errors?: string[];
}

export interface LockMirroringResult {
  valid: boolean;
  shouldMirror: boolean;
  mirroredSession?: Record<string, any>;
  error?: string;
}

// In-memory store for unit testing when Firestore Admin SDK is not active or mock store is enabled
const migrationMockStore = new Map<string, any>();
let mockTransactionFailureInjector: (() => void) | null = null;

export function clearMigrationMockStore(): void {
  migrationMockStore.clear();
  mockTransactionFailureInjector = null;
}

export function setMigrationMockDoc(path: string, data: any): void {
  migrationMockStore.set(path, data ? JSON.parse(JSON.stringify(data)) : null);
}

export function getMigrationMockDoc(path: string): any {
  return migrationMockStore.get(path);
}

export function setMockTransactionFailureInjector(fn: (() => void) | null): void {
  mockTransactionFailureInjector = fn;
}

/**
 * Stage 2A — Authoritative Risk Data Migration Utility (Fail-Closed Safety Pass)
 *
 * Responsibilities:
 * 1. Single atomic transaction reading all required docs before issuing writes.
 * 2. Migration completion metadata stored ONLY in `users/{userId}/system/migrationState` (schemaVersion: 2).
 * 3. Reconciles legacy vs account-level RiskConfigs. FAILS CLOSED with 0 writes if both configs are missing or invalid.
 * 4. Runs canonical validation (validateRiskConfig) and sanitizes documents before writing.
 * 5. Preserves `users/{userId}/riskSessions/{tradingDate}` completely unchanged and untouched.
 * 6. Mirrors active legacy locks to `users/{userId}/accountRiskSessions/{accountId}__{tradingDate}` preserving field values verbatim.
 * 7. ABORTS ENTIRE MIGRATION WITH 0 WRITES if a present legacy session has a missing or mismatched tradingDate.
 * 8. Strictly idempotent: schemaVersion >= 2 results in 0 writes.
 */
/**
 * Compares a live document snapshot against a pre-migration backup payload.
 * Aborts migration if any document existence or content was modified post-backup.
 */
export function checkBackupDocumentStaleness(
  docPath: string,
  liveData: any,
  liveExists: boolean,
  expectedBackup?: any
): string | null {
  if (!expectedBackup || !Array.isArray(expectedBackup.documents)) return null;
  const backupEntry = expectedBackup.documents.find((d: any) => d.path === docPath);
  if (!backupEntry) return null;

  if (backupEntry.exists !== liveExists) {
    return `BACKUP_STALE_CONCURRENT_MUTATION: Document '${docPath}' existence changed from ${backupEntry.exists} at backup time to ${liveExists} at transaction execution time. Aborting migration writes.`;
  }

  if (liveExists) {
    const backupStr = JSON.stringify(backupEntry.data || null);
    const liveStr = JSON.stringify(liveData || null);
    if (backupStr !== liveStr) {
      return `BACKUP_STALE_CONCURRENT_MUTATION: Document '${docPath}' content was modified after backup creation. Aborting migration writes.`;
    }
  }

  return null;
}

export async function migrateUserRiskData(
  userId: string,
  accountId = 'acc_mt_zerodha_default',
  tradingDate?: string,
  now: Date = new Date(),
  expectedBackup?: any
): Promise<MigrationResult> {
  if (!userId || !userId.trim()) {
    return { success: false, schemaVersion: 0, errors: ['userId is required'] };
  }

  const cleanUserId = userId.trim();
  const effectiveTradingDate = tradingDate || getTradingDateKolkata(now);

  const migrationDocPath = `users/${cleanUserId}/system/migrationState`;
  const legacyConfigDocPath = `users/${cleanUserId}/riskConfig/config`;
  const accountConfigDocPath = `users/${cleanUserId}/accountRiskConfigs/${accountId}`;
  const legacySessionDocPath = `users/${cleanUserId}/riskSessions/${effectiveTradingDate}`;
  const accountSessionDocPath = `users/${cleanUserId}/accountRiskSessions/${accountId}__${effectiveTradingDate}`;

  const adminDb = getAdminFirestore();
  const isMock = isMockStoreEnabled();

  // --------------------------------------------------------------------------
  // PATH A: Real Admin Firestore Transaction
  // --------------------------------------------------------------------------
  if (adminDb && !isMock) {
    try {
      const migrationRef = adminDb.doc(migrationDocPath);
      const legacyConfigRef = adminDb.doc(legacyConfigDocPath);
      const accountConfigRef = adminDb.doc(accountConfigDocPath);
      const legacySessionRef = adminDb.doc(legacySessionDocPath);
      const accountSessionRef = adminDb.doc(accountSessionDocPath);

      return await adminDb.runTransaction(async (tx) => {
        // STEP 1: READ ALL REQUIRED DOCUMENTS FIRST
        const [
          migrationSnap,
          legacyConfigSnap,
          accountConfigSnap,
          legacySessionSnap,
          accountSessionSnap,
        ] = await Promise.all([
          tx.get(migrationRef),
          tx.get(legacyConfigRef),
          tx.get(accountConfigRef),
          tx.get(legacySessionRef),
          tx.get(accountSessionRef),
        ]);

        // Backup Staleness Guard: Check for concurrent mutations post-backup
        if (expectedBackup) {
          const checkEntries = [
            { path: migrationDocPath, data: migrationSnap.exists ? migrationSnap.data() : null, exists: migrationSnap.exists },
            { path: legacyConfigDocPath, data: legacyConfigSnap.exists ? legacyConfigSnap.data() : null, exists: legacyConfigSnap.exists },
            { path: accountConfigDocPath, data: accountConfigSnap.exists ? accountConfigSnap.data() : null, exists: accountConfigSnap.exists },
            { path: legacySessionDocPath, data: legacySessionSnap.exists ? legacySessionSnap.data() : null, exists: legacySessionSnap.exists },
            { path: accountSessionDocPath, data: accountSessionSnap.exists ? accountSessionSnap.data() : null, exists: accountSessionSnap.exists },
          ];

          for (const entry of checkEntries) {
            const staleErr = checkBackupDocumentStaleness(entry.path, entry.data, entry.exists, expectedBackup);
            if (staleErr) {
              return { success: false, schemaVersion: 0, errors: [staleErr] };
            }
          }
        }

        // Idempotency check: schemaVersion >= 2
        if (migrationSnap.exists) {
          const migData = migrationSnap.data();
          if (migData && typeof migData.schemaVersion === 'number' && migData.schemaVersion >= 2) {
            return {
              success: true,
              skipped: true,
              schemaVersion: migData.schemaVersion,
              migratedAt: migData.migratedAt,
            };
          }
        }

        // STEP 2: RECONCILE CONFIGURATIONS (FAILS CLOSED IF BOTH ARE MISSING / INVALID)
        const legacyRaw = legacyConfigSnap.exists ? legacyConfigSnap.data() : null;
        const accountRaw = accountConfigSnap.exists ? accountConfigSnap.data() : null;

        const { reconciledConfig, errors } = reconcileRiskConfigs(legacyRaw, accountRaw, now);
        if (!reconciledConfig) {
          return {
            success: false,
            schemaVersion: 0,
            errors: errors || ['Configuration reconciliation failed: both configs missing or invalid.'],
          };
        }

        // STEP 3: CHECK LEGACY LOCK & MIRROR IF ACTIVE
        const legacySession = legacySessionSnap.exists
          ? (legacySessionSnap.data() as RiskSession)
          : null;
        const existingAccountSession = accountSessionSnap.exists
          ? (accountSessionSnap.data() as RiskSession)
          : null;

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
            success: false,
            schemaVersion: 0,
            errors: [mirrorResult.error || 'Legacy session date validation failed.'],
          };
        }

        const shouldMirror = mirrorResult.shouldMirror;
        const mirroredSession = mirrorResult.mirroredSession;

        // STEP 4: ISSUE WRITES (ALL READS COMPLETED BEFORE ANY WRITE)
        tx.set(accountConfigRef, reconciledConfig);
        tx.set(legacyConfigRef, reconciledConfig);

        if (shouldMirror && mirroredSession) {
          tx.set(accountSessionRef, mirroredSession);
        }

        const migrationState = {
          schemaVersion: 2,
          migratedAt: now.toISOString(),
          accountId,
        };
        tx.set(migrationRef, migrationState);

        return {
          success: true,
          skipped: false,
          schemaVersion: 2,
          migratedAt: migrationState.migratedAt,
          reconciledConfig,
          sessionMirrored: shouldMirror,
        };
      });
    } catch (err: any) {
      console.error(`[Migration] Transaction failed for user ${cleanUserId}:`, err);
      return {
        success: false,
        schemaVersion: 0,
        errors: [`FIRESTORE_TRANSACTION_FAILURE: ${err?.message || String(err)}`],
      };
    }
  }

  // --------------------------------------------------------------------------
  // PATH B: Transactional Mock Store Execution
  // --------------------------------------------------------------------------

  // STEP 1: READ ALL REQUIRED DOCUMENTS
  const migrationData = migrationMockStore.get(migrationDocPath);
  if (migrationData && typeof migrationData.schemaVersion === 'number' && migrationData.schemaVersion >= 2) {
    return {
      success: true,
      skipped: true,
      schemaVersion: migrationData.schemaVersion,
      migratedAt: migrationData.migratedAt,
    };
  }

  const legacyRaw = migrationMockStore.get(legacyConfigDocPath) || null;
  const accountRaw = migrationMockStore.get(accountConfigDocPath) || null;
  const legacySession = migrationMockStore.get(legacySessionDocPath) as RiskSession | null;
  const existingAccountSession = migrationMockStore.get(accountSessionDocPath) as RiskSession | null;

  // Backup Staleness Guard in Mock Execution
  if (expectedBackup) {
    const checkEntries = [
      { path: migrationDocPath, data: migrationData, exists: migrationData !== undefined && migrationData !== null },
      { path: legacyConfigDocPath, data: legacyRaw, exists: legacyRaw !== undefined && legacyRaw !== null },
      { path: accountConfigDocPath, data: accountRaw, exists: accountRaw !== undefined && accountRaw !== null },
      { path: legacySessionDocPath, data: legacySession, exists: legacySession !== undefined && legacySession !== null },
      { path: accountSessionDocPath, data: existingAccountSession, exists: existingAccountSession !== undefined && existingAccountSession !== null },
    ];

    for (const entry of checkEntries) {
      const staleErr = checkBackupDocumentStaleness(entry.path, entry.data, entry.exists, expectedBackup);
      if (staleErr) {
        return { success: false, schemaVersion: 0, errors: [staleErr] };
      }
    }
  }

  // STEP 2: RECONCILE CONFIGURATIONS (FAILS CLOSED IF BOTH ARE MISSING / INVALID)
  const { reconciledConfig, errors } = reconcileRiskConfigs(legacyRaw, accountRaw, now);
  if (!reconciledConfig) {
    return {
      success: false,
      schemaVersion: 0,
      errors: errors || ['Configuration reconciliation failed: both configs missing or invalid.'],
    };
  }

  // STEP 3: EVALUATE LOCK MIRRORING (ABORTS MIGRATION IF LEGACY SESSION HAS MISMATCHED/MISSING DATE)
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
      success: false,
      schemaVersion: 0,
      errors: [mirrorResult.error || 'Legacy session date validation failed.'],
    };
  }

  const shouldMirror = mirrorResult.shouldMirror;
  const mirroredSession = mirrorResult.mirroredSession;

  // STEP 4: STAGE ALL PROPOSED WRITES IN A TRANSACTION STAGING MAP
  const stagedWrites = new Map<string, any>();
  stagedWrites.set(accountConfigDocPath, JSON.parse(JSON.stringify(reconciledConfig)));
  stagedWrites.set(legacyConfigDocPath, JSON.parse(JSON.stringify(reconciledConfig)));

  if (shouldMirror && mirroredSession) {
    stagedWrites.set(accountSessionDocPath, JSON.parse(JSON.stringify(mirroredSession)));
  }

  const migrationState = {
    schemaVersion: 2,
    migratedAt: now.toISOString(),
    accountId,
  };
  stagedWrites.set(migrationDocPath, migrationState);

  // SIMULATE TRANSACTION FAILURE IF INJECTED (Verifies atomic rollback & zero partial writes)
  if (mockTransactionFailureInjector) {
    try {
      mockTransactionFailureInjector();
    } catch (injErr: any) {
      return {
        success: false,
        schemaVersion: 0,
        errors: [`TRANSACTION_ABORTED: ${injErr?.message || String(injErr)}`],
      };
    }
  }

  // COMMIT PHASE: Apply staged writes atomically to migrationMockStore
  for (const [path, val] of stagedWrites.entries()) {
    migrationMockStore.set(path, val);
  }

  return {
    success: true,
    skipped: false,
    schemaVersion: 2,
    migratedAt: migrationState.migratedAt,
    reconciledConfig,
    sessionMirrored: shouldMirror,
  };
}

/**
 * Validates whether a dailyLossLimit or maxLoss numeric value satisfies all strict limit rules:
 * - Finite number, > 0, >= 500, and in increments of 500.
 */
export function isValidLossLimit(val: any): boolean {
  if (typeof val !== 'number' || isNaN(val) || !isFinite(val)) {
    return false;
  }
  return val >= 500 && val % 500 === 0;
}

/**
 * Resolves effective dailyLossLimit with alias precedence:
 * 1. Selects valid `dailyLossLimit` first.
 * 2. If invalid or absent, selects valid `maxLoss`.
 * 3. Otherwise returns approved default (`DEFAULT_RISK_CONFIG.dailyLossLimit`).
 */
export function resolveLossLimit(raw: any): number {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return DEFAULT_RISK_CONFIG.dailyLossLimit;
  }

  if (isValidLossLimit(raw.dailyLossLimit)) {
    return raw.dailyLossLimit;
  }

  if (isValidLossLimit(raw.maxLoss)) {
    return raw.maxLoss;
  }

  return DEFAULT_RISK_CONFIG.dailyLossLimit;
}

/**
 * Normalizes a raw config object by applying alias precedence to set `dailyLossLimit` and removing `maxLoss`.
 */
export function normalizeConfigObject(raw: any): any {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const clone = { ...raw };
  const effectiveLimit = resolveLossLimit(clone);
  clone.dailyLossLimit = effectiveLimit;
  delete clone.maxLoss;
  return clone;
}

/**
 * Parses raw `updatedAt` string from unvalidated input doc.
 * Returns timestamp number in ms if valid ISO string, or null if missing/invalid.
 */
export function parseRawTimestamp(raw: any): number | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const ts = raw.updatedAt;
  if (typeof ts !== 'string' || !ts.trim()) return null;
  const ms = new Date(ts).getTime();
  return isNaN(ms) ? null : ms;
}

/**
 * Reconciles legacy vs account-level risk configurations.
 * Rules:
 * 1. Extract original raw timestamp validity before running validation.
 * 2. Select valid `dailyLossLimit` first; fallback to valid `maxLoss`; fallback to default limit.
 * 3. Timestamp precedence: Highest valid original `updatedAt` wins.
 * 4. Equal or missing timestamps: Account-level config takes precedence.
 * 5. Sanitize document completely before returning.
 * 6. FAIL CLOSED: If both legacy and account configs are missing or invalid, return failure error without writing defaults.
 */
export function reconcileRiskConfigs(
  legacyRaw: any,
  accountRaw: any,
  now: Date
): { reconciledConfig?: RiskConfig; errors?: string[] } {
  // Extract original raw timestamps BEFORE running validation that injects generated timestamps
  const legacyTime = parseRawTimestamp(legacyRaw);
  const accountTime = parseRawTimestamp(accountRaw);

  // Normalize loss limit alias
  const prepLegacy = normalizeConfigObject(legacyRaw);
  const prepAccount = normalizeConfigObject(accountRaw);

  const legacyVal = prepLegacy ? validateRiskConfig(prepLegacy) : null;
  const accountVal = prepAccount ? validateRiskConfig(prepAccount) : null;

  const validLegacyConfig = legacyVal?.valid ? legacyVal.sanitized : null;
  const validAccountConfig = accountVal?.valid ? accountVal.sanitized : null;

  let chosen: RiskConfig | null = null;

  if (validLegacyConfig && validAccountConfig) {
    if (legacyTime !== null && accountTime !== null) {
      if (legacyTime > accountTime) {
        chosen = validLegacyConfig;
      } else {
        // accountTime >= legacyTime -> Account-level precedence
        chosen = validAccountConfig;
      }
    } else if (legacyTime !== null) {
      chosen = validLegacyConfig;
    } else if (accountTime !== null) {
      chosen = validAccountConfig;
    } else {
      // Both timestamps missing or invalid -> Account-level precedence
      chosen = validAccountConfig;
    }
  } else if (validAccountConfig) {
    chosen = validAccountConfig;
  } else if (validLegacyConfig) {
    chosen = validLegacyConfig;
  } else {
    // Neither config exists or both configs are invalid -> FAIL CLOSED!
    return {
      errors: [
        'MIGRATION_FAILED_NO_VALID_CONFIG: Both legacy and account-level risk configurations are missing or invalid.',
      ],
    };
  }

  // Final sanitization pass
  const reval = validateRiskConfig(chosen);
  if (!reval.valid || !reval.sanitized) {
    return { errors: reval.errors };
  }

  const finalConfig: RiskConfig = {
    ...reval.sanitized,
    updatedAt: now.toISOString(),
  };

  return { reconciledConfig: finalConfig };
}

/**
 * Checks whether a risk session lock is active under exact Risk Engine lock-expiry semantics:
 * 1. When expectedTradingDate is supplied, require session.tradingDate === expectedTradingDate.
 * 2. Must be locked (`state === 'LOCKED'` or `isBreached === true`).
 * 3. Missing or null `lockUntil` means indefinite active lock.
 * 4. An invalid non-null `lockUntil` (e.g. `'invalid-date'`) is NOT active.
 * 5. Valid date string is active if `now.getTime() < lockUntilMs`.
 */
export function checkIsLockActive(
  session: RiskSession | null,
  now: Date,
  expectedTradingDate?: string
): boolean {
  if (!session) return false;

  // When expectedTradingDate is supplied, require session.tradingDate === expectedTradingDate.
  // Rejects both mismatched and missing session dates.
  if (expectedTradingDate !== undefined && session.tradingDate !== expectedTradingDate) {
    return false;
  }

  const isLocked = session.state === 'LOCKED' || session.isBreached === true;
  if (!isLocked) return false;

  const rawLockUntil = session.lockUntil;
  // Missing or null -> Indefinite active lock
  if (rawLockUntil === null || rawLockUntil === undefined) {
    return true;
  }

  // Non-null string -> parse timestamp
  const lockUntilMs = new Date(rawLockUntil).getTime();
  // Invalid non-null date string (NaN) -> NOT active!
  if (isNaN(lockUntilMs)) {
    return false;
  }

  // Active if current evaluation time is strictly BEFORE lockUntil expiration time
  return now.getTime() < lockUntilMs;
}

/**
 * Determines whether the legacy risk session lock is active and should be mirrored.
 * Case A: No legacy session exists -> valid, do not mirror.
 * Case B: Legacy session exists with matching tradingDate -> evaluate lock eligibility.
 * Case C: Legacy session exists with missing or mismatched tradingDate -> ABORT ENTIRE MIGRATION!
 */
export function evaluateLockMirroring(
  legacySession: RiskSession | null,
  existingAccountSession: RiskSession | null,
  userId: string,
  accountId: string,
  tradingDate: string,
  reconciledConfig: RiskConfig,
  now: Date
): LockMirroringResult {
  // Case A: No legacy session exists -> valid, do not mirror
  if (!legacySession) {
    return { valid: true, shouldMirror: false };
  }

  // Case C: Legacy session exists but its tradingDate is missing or mismatched -> ABORT MIGRATION!
  if (!legacySession.tradingDate || legacySession.tradingDate !== tradingDate) {
    return {
      valid: false,
      shouldMirror: false,
      error: `MIGRATION_FAILED_INVALID_SESSION_DATE: Legacy risk session tradingDate '${legacySession.tradingDate}' does not match target trading date '${tradingDate}'.`,
    };
  }

  // Case B: Legacy session exists and tradingDate matches target date.
  const isLegacyActive = checkIsLockActive(legacySession, now, tradingDate);
  if (!isLegacyActive) {
    return { valid: true, shouldMirror: false };
  }

  // Legacy lock is ACTIVE on tradingDate.
  // Check if existing account session is already active on tradingDate:
  if (existingAccountSession && checkIsLockActive(existingAccountSession, now, tradingDate)) {
    // Existing account session is already active on tradingDate — preserve without overwriting
    return { valid: true, shouldMirror: false };
  }

  // Preserve the legacy session's existing fields and values verbatim when mirroring!
  // Do NOT fabricate fallback P&L, timestamps, reasons, or thresholds.
  // Add only fields required by the established account-session schema.
  const mirroredSession: Record<string, any> = {
    ...legacySession,
    userId,
    accountId,
    tradingDate: legacySession.tradingDate,
    updatedAt: now.toISOString(),
  };

  return { valid: true, shouldMirror: true, mirroredSession };
}
