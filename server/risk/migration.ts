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

// In-memory store for unit testing when Firestore Admin SDK is not active or mock store is enabled
const migrationMockStore = new Map<string, any>();

export function clearMigrationMockStore(): void {
  migrationMockStore.clear();
}

export function setMigrationMockDoc(path: string, data: any): void {
  migrationMockStore.set(path, data ? JSON.parse(JSON.stringify(data)) : null);
}

export function getMigrationMockDoc(path: string): any {
  return migrationMockStore.get(path);
}

/**
 * Stage 2A — Authoritative Risk Data Migration Utility
 *
 * Responsibilities:
 * 1. Single atomic transaction reading all required docs before issuing writes.
 * 2. Migration completion metadata stored ONLY in `users/{userId}/system/migrationState` (schemaVersion: 2).
 * 3. Reconciles legacy vs account-level RiskConfigs using timestamp precedence and maxLoss alias fallback.
 * 4. Runs canonical validation (validateRiskConfig) and sanitizes documents before writing.
 * 5. Preserves `users/{userId}/riskSessions/{tradingDate}` completely unchanged.
 * 6. Mirrors active legacy locks to `users/{userId}/accountRiskSessions/{accountId}__{tradingDate}`.
 * 7. Strictly idempotent: schemaVersion >= 2 results in 0 writes.
 */
export async function migrateUserRiskData(
  userId: string,
  accountId = 'acc_mt_zerodha_default',
  tradingDate?: string,
  now: Date = new Date()
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

        // STEP 2: RECONCILE CONFIGURATIONS
        const legacyRaw = legacyConfigSnap.exists ? legacyConfigSnap.data() : null;
        const accountRaw = accountConfigSnap.exists ? accountConfigSnap.data() : null;

        const { reconciledConfig, errors } = reconcileRiskConfigs(legacyRaw, accountRaw, now);
        if (!reconciledConfig) {
          return {
            success: false,
            schemaVersion: 0,
            errors: errors || ['Configuration reconciliation failed'],
          };
        }

        // STEP 3: CHECK LEGACY LOCK & MIRROR IF ACTIVE
        const legacySession = legacySessionSnap.exists
          ? (legacySessionSnap.data() as RiskSession)
          : null;
        const existingAccountSession = accountSessionSnap.exists
          ? (accountSessionSnap.data() as RiskSession)
          : null;

        const { shouldMirror, mirroredSession } = evaluateLockMirroring(
          legacySession,
          existingAccountSession,
          cleanUserId,
          accountId,
          effectiveTradingDate,
          reconciledConfig,
          now
        );

        // STEP 4: ISSUE WRITES (READS COMPLETED)
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
  // PATH B: Mock Store / Testing Execution
  // --------------------------------------------------------------------------
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

  const { reconciledConfig, errors } = reconcileRiskConfigs(legacyRaw, accountRaw, now);
  if (!reconciledConfig) {
    return {
      success: false,
      schemaVersion: 0,
      errors: errors || ['Configuration reconciliation failed'],
    };
  }

  const legacySession = migrationMockStore.get(legacySessionDocPath) as RiskSession | null;
  const existingAccountSession = migrationMockStore.get(accountSessionDocPath) as RiskSession | null;

  const { shouldMirror, mirroredSession } = evaluateLockMirroring(
    legacySession,
    existingAccountSession,
    cleanUserId,
    accountId,
    effectiveTradingDate,
    reconciledConfig,
    now
  );

  // Write reconciled state to mock store
  migrationMockStore.set(accountConfigDocPath, JSON.parse(JSON.stringify(reconciledConfig)));
  migrationMockStore.set(legacyConfigDocPath, JSON.parse(JSON.stringify(reconciledConfig)));

  if (shouldMirror && mirroredSession) {
    migrationMockStore.set(accountSessionDocPath, JSON.parse(JSON.stringify(mirroredSession)));
  }

  const migrationState = {
    schemaVersion: 2,
    migratedAt: now.toISOString(),
    accountId,
  };
  migrationMockStore.set(migrationDocPath, migrationState);

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
 * Reconciles legacy vs account-level risk configurations.
 * Rules:
 * 1. Alias `maxLoss` to `dailyLossLimit` if `dailyLossLimit` is absent.
 * 2. Validate legacy and account configs using `validateRiskConfig`.
 * 3. Timestamp comparison: Highest valid `updatedAt` wins.
 * 4. Equal / missing timestamps: Account-level config takes precedence.
 * 5. Sanitize document completely before returning.
 */
export function reconcileRiskConfigs(
  legacyRaw: any,
  accountRaw: any,
  now: Date
): { reconciledConfig?: RiskConfig; errors?: string[] } {
  // Normalize alias fallback for maxLoss -> dailyLossLimit
  const prepLegacy = normalizeMaxLossAlias(legacyRaw);
  const prepAccount = normalizeMaxLossAlias(accountRaw);

  const legacyVal = prepLegacy ? validateRiskConfig(prepLegacy) : null;
  const accountVal = prepAccount ? validateRiskConfig(prepAccount) : null;

  const validLegacyConfig = legacyVal?.valid ? legacyVal.sanitized : null;
  const validAccountConfig = accountVal?.valid ? accountVal.sanitized : null;

  let chosen: RiskConfig | null = null;

  if (validLegacyConfig && validAccountConfig) {
    const legacyTime = parseTimestamp(validLegacyConfig.updatedAt);
    const accountTime = parseTimestamp(validAccountConfig.updatedAt);

    if (legacyTime !== null && accountTime !== null) {
      if (legacyTime > accountTime) {
        chosen = validLegacyConfig;
      } else {
        // accountTime >= legacyTime -> Account-level precedence
        chosen = validAccountConfig;
      }
    } else if (legacyTime !== null) {
      chosen = validLegacyConfig;
    } else {
      chosen = validAccountConfig;
    }
  } else if (validAccountConfig) {
    chosen = validAccountConfig;
  } else if (validLegacyConfig) {
    chosen = validLegacyConfig;
  } else {
    // Default baseline if neither document exists or both are invalid
    chosen = {
      ...DEFAULT_RISK_CONFIG,
      updatedAt: now.toISOString(),
    };
  }

  // Final sanitization check
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

function normalizeMaxLossAlias(raw: any): any {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const clone = { ...raw };
  if (clone.dailyLossLimit === undefined && clone.maxLoss !== undefined) {
    clone.dailyLossLimit = clone.maxLoss;
    delete clone.maxLoss;
  }
  return clone;
}

function parseTimestamp(ts?: string): number | null {
  if (!ts) return null;
  const parsed = new Date(ts).getTime();
  return isNaN(parsed) ? null : parsed;
}

/**
 * Determines whether the legacy risk session lock is active and should be mirrored.
 * Semantics:
 * A lock is active if:
 * 1. `state === 'LOCKED'` OR `isBreached === true`
 * 2. AND (`lockUntil` is missing/null [indefinite lock] OR `new Date(lockUntil).getTime() > now.getTime()`).
 *
 * Conflict resolution:
 * If an account-level risk session already exists and is active, preserve it.
 * If legacy session is active, mirror it to account-level risk session without inventing fields.
 */
export function evaluateLockMirroring(
  legacySession: RiskSession | null,
  existingAccountSession: RiskSession | null,
  userId: string,
  accountId: string,
  tradingDate: string,
  reconciledConfig: RiskConfig,
  now: Date
): { shouldMirror: boolean; mirroredSession?: RiskSession & { accountId?: string } } {
  if (!legacySession) {
    return { shouldMirror: false };
  }

  const isLegacyLocked = legacySession.state === 'LOCKED' || legacySession.isBreached === true;
  if (!isLegacyLocked) {
    return { shouldMirror: false };
  }

  const lockUntilMs = legacySession.lockUntil ? new Date(legacySession.lockUntil).getTime() : null;
  const isLockActive = lockUntilMs === null || isNaN(lockUntilMs) || lockUntilMs > now.getTime();

  if (!isLockActive) {
    return { shouldMirror: false };
  }

  // Legacy lock is ACTIVE.
  // Check if existing account session is already active:
  if (existingAccountSession) {
    const isAccountLocked =
      existingAccountSession.state === 'LOCKED' || existingAccountSession.isBreached === true;
    const accountLockUntilMs = existingAccountSession.lockUntil
      ? new Date(existingAccountSession.lockUntil).getTime()
      : null;
    const isAccountActive =
      isAccountLocked &&
      (accountLockUntilMs === null || isNaN(accountLockUntilMs) || accountLockUntilMs > now.getTime());

    if (isAccountActive) {
      // Existing account session is already locked and active — do not overwrite active lock
      return { shouldMirror: false };
    }
  }

  // Mirror legacy active lock to account risk session without inventing extra fields
  const mirroredSession: RiskSession & { accountId?: string } = {
    tradingDate: legacySession.tradingDate || tradingDate,
    userId,
    accountId,
    state: legacySession.state || 'LOCKED',
    isBreached: legacySession.isBreached ?? true,
    lockedAt: legacySession.lockedAt || now.toISOString(),
    lockUntil: legacySession.lockUntil ?? null,
    currentPnl: legacySession.currentPnl ?? 0,
    realisedPnl: legacySession.realisedPnl ?? 0,
    unrealisedPnl: legacySession.unrealisedPnl ?? 0,
    lossLimit: legacySession.lossLimit ?? reconciledConfig.dailyLossLimit,
    warningThreshold1: legacySession.warningThreshold1 ?? reconciledConfig.warningThreshold1,
    warningThreshold2: legacySession.warningThreshold2 ?? reconciledConfig.warningThreshold2,
    lastEvaluatedAt: legacySession.lastEvaluatedAt || now.toISOString(),
    reason: legacySession.reason || 'Daily loss limit breached (Mirrored)',
    updatedAt: now.toISOString(),
  };

  return { shouldMirror: true, mirroredSession };
}
