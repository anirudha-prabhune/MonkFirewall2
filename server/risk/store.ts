import { getAdminFirestore, isMockStoreEnabled } from '../brokers/zerodha/sessionStore';
import {
  RiskConfig,
  DEFAULT_RISK_CONFIG,
  DEFAULT_ACCOUNT_ID,
  DEFAULT_ANGELONE_ACCOUNT_ID,
  DEFAULT_ANGELONE_RISK_CONFIG,
  AccountRiskConfig,
} from '../../src/types/risk';
import {
  RiskEngine,
  RiskSession,
  RiskEvent,
  RiskEvaluationResult,
  getTradingDateKolkata,
  isNseMarketClosed,
} from './engine';
import { validateRiskConfig } from './validation';
import { PnlResult } from '../pnl/types';
import { PnlEngine } from '../pnl/engine';
import { BrokerService } from '../brokers/service';
import { ShadowRiskService } from './shadowRiskService';

/**
 * Server-authoritative Risk Store and Session Manager (Phase 5 / Phase 7B.1).
 *
 * Guarantees:
 * - Backed by Firestore ACID transactions (runTransaction) for state transitions & persistence
 * - Consumes PnlResult directly from Phase 4 PnlEngine
 * - Server evaluates PnlResult from normalized positions; does NOT trust client-submitted P&L
 * - Thread-safe atomic evaluation preventing concurrent lock creation race conditions
 * - Preserves existing active lock when configuration is modified or disabled
 * - Account-scoped isolation: Zerodha & Angel One accounts operate on isolated configs & sessions
 * - Angel One defaults to OBSERVE_ONLY execution mode with zero cross-broker lock leakage
 * - Preserves legacy Zerodha dual-write for 100% backward compatibility
 */

export { DEFAULT_ACCOUNT_ID, DEFAULT_ANGELONE_ACCOUNT_ID };

interface UserRiskState {
  config: RiskConfig;
  accountConfigs: Map<string, RiskConfig>; // accountId -> RiskConfig
  sessions: Map<string, RiskSession>; // tradingDate -> RiskSession
  accountSessions: Map<string, RiskSession>; // `${accountId}__${tradingDate}` -> RiskSession
  events: RiskEvent[];
  loadedFromFirestore?: boolean;
}

export class ServerRiskStore {
  private static userStates = new Map<string, UserRiskState>();

  /**
   * Resolves the authoritative account ID for a user.
   * If explicit accountId is provided, returns it.
   * Otherwise inspects users/{userId}/system/migrationState.
   * If migrationState exists and specifies accountId, uses that.
   * Falls back to DEFAULT_ACCOUNT_ID ('acc_mt_zerodha_default').
   */
  public static async resolveAccountId(userId: string, accountId?: string): Promise<string> {
    if (accountId && typeof accountId === 'string' && accountId.trim().length > 0) {
      return accountId.trim();
    }
    const adminDb = getAdminFirestore();
    if (adminDb) {
      try {
        const snap = await adminDb.doc(`users/${userId}/system/migrationState`).get();
        if (snap.exists) {
          const data = snap.data();
          if (data && typeof data.accountId === 'string' && data.accountId.trim().length > 0) {
            return data.accountId.trim();
          }
        }
      } catch (err) {
        console.warn(`[RiskStore] Failed to resolve migrationState for user ${userId}, falling back to default:`, err);
      }
    }
    return DEFAULT_ACCOUNT_ID;
  }

  private static getOrCreateUserState(userId: string): UserRiskState {
    let state = this.userStates.get(userId);
    if (!state) {
      state = {
        config: { ...DEFAULT_RISK_CONFIG, updatedAt: new Date().toISOString() },
        accountConfigs: new Map(),
        sessions: new Map(),
        accountSessions: new Map(),
        events: [],
        loadedFromFirestore: false,
      };
      this.userStates.set(userId, state);
    }
    return state;
  }

  public static async getConfig(userId: string, accountId?: string): Promise<RiskConfig> {
    const userState = this.getOrCreateUserState(userId);
    const resolvedAccountId = await this.resolveAccountId(userId, accountId);
    
    // Check in-memory account config cache first
    const cachedAccountConfig = userState.accountConfigs.get(resolvedAccountId);
    if (cachedAccountConfig) {
      return { ...cachedAccountConfig };
    }

    if (!userState.loadedFromFirestore || !userState.accountConfigs.has(resolvedAccountId)) {
      const adminDb = getAdminFirestore();
      const isProduction = process.env.NODE_ENV === 'production';
      const isMock = isMockStoreEnabled();

      if (isProduction && !adminDb && !isMock) {
        throw new Error(`FIRESTORE_READ_FAILURE: Authoritative Firestore is unavailable in production for user ${userId}.`);
      }

      if (adminDb) {
        try {
          // Read account config first, fallback to legacy config path
          const accountDocRef = adminDb.doc(`users/${userId}/accountRiskConfigs/${resolvedAccountId}`);
          const legacyDocRef = adminDb.doc(`users/${userId}/riskConfig/config`);
          const [accountSnap, legacySnap] = await Promise.all([
            accountDocRef.get(),
            resolvedAccountId === DEFAULT_ACCOUNT_ID ? legacyDocRef.get() : Promise.resolve({ exists: false } as any)
          ]);

          if (accountSnap.exists) {
            const raw = accountSnap.data();
            const validation = validateRiskConfig(raw);
            if (validation.valid && validation.sanitized) {
              userState.accountConfigs.set(resolvedAccountId, validation.sanitized);
              if (resolvedAccountId === DEFAULT_ACCOUNT_ID) {
                userState.config = validation.sanitized;
              }
            }
          } else if (resolvedAccountId === DEFAULT_ACCOUNT_ID && legacySnap.exists) {
            const raw = legacySnap.data();
            const validation = validateRiskConfig(raw);
            if (validation.valid && validation.sanitized) {
              userState.config = validation.sanitized;
              userState.accountConfigs.set(resolvedAccountId, validation.sanitized);
            }
          }
          userState.loadedFromFirestore = true;
        } catch (err) {
          console.error(`[RiskStore] getConfig from Firestore failed for user ${userId}:`, err);
          throw new Error(
            `FIRESTORE_READ_FAILURE: Failed to read riskConfig from Firestore for user ${userId}: ${
              err instanceof Error ? err.message : String(err)
            }`
          );
        }
      } else {
        userState.loadedFromFirestore = true;
      }
    }

    // Default configuration resolution
    let effectiveConfig = userState.accountConfigs.get(resolvedAccountId);
    if (!effectiveConfig) {
      if (resolvedAccountId === DEFAULT_ANGELONE_ACCOUNT_ID || resolvedAccountId.includes('angelone')) {
        effectiveConfig = {
          ...DEFAULT_ANGELONE_RISK_CONFIG,
          accountId: resolvedAccountId,
          updatedAt: new Date().toISOString(),
        };
      } else {
        const base = userState.config || DEFAULT_RISK_CONFIG;
        effectiveConfig = {
          dailyLossLimit: base.dailyLossLimit,
          warningThreshold1: base.warningThreshold1,
          warningThreshold2: base.warningThreshold2,
          lockDurationMinutes: base.lockDurationMinutes,
          lockDurationType: base.lockDurationType || 'FIXED',
          includeRealisedPnl: base.includeRealisedPnl,
          includeUnrealisedPnl: base.includeUnrealisedPnl,
          enabled: base.enabled,
          executionMode: base.executionMode || 'ENFORCE',
          broker: base.broker || 'zerodha',
          scope: base.scope || 'ACCOUNT',
          accountId: resolvedAccountId,
          updatedAt: new Date().toISOString(),
        };
      }
      userState.accountConfigs.set(resolvedAccountId, effectiveConfig);
    }

    return { ...effectiveConfig };
  }

  public static async saveConfig(
    userId: string,
    rawInput: any,
    accountId?: string
  ): Promise<{ success: boolean; config?: RiskConfig; errors?: string[]; code?: string }> {
    const validation = validateRiskConfig(rawInput);
    if (!validation.valid || !validation.sanitized) {
      console.warn(`[RiskStore] Config validation failed for user ${userId}:`, validation.errors);
      return { success: false, errors: validation.errors };
    }

    const userState = this.getOrCreateUserState(userId);
    const resolvedAccountId = await this.resolveAccountId(userId, accountId);
    const currentConfig = await this.getConfig(userId, resolvedAccountId);
    const sanitized = { ...validation.sanitized };

    // Enforce account identity and broker execution boundaries
    const isAngelOne = resolvedAccountId === DEFAULT_ANGELONE_ACCOUNT_ID || resolvedAccountId.includes('angelone');
    if (isAngelOne) {
      sanitized.broker = 'angelone';
      sanitized.executionMode = 'OBSERVE_ONLY'; // Angel One enforcement is strictly prohibited
      sanitized.accountId = resolvedAccountId;
      sanitized.scope = 'ACCOUNT';
    } else {
      sanitized.broker = sanitized.broker || 'zerodha';
      sanitized.executionMode = sanitized.executionMode || currentConfig.executionMode || 'ENFORCE';
      sanitized.accountId = resolvedAccountId;
      sanitized.scope = sanitized.scope || currentConfig.scope || 'ACCOUNT';
    }

    // Phase 11C: LOCKED Config Immutability Guard
    const today = getTradingDateKolkata(new Date());
    const accountSessionKey = `${resolvedAccountId}__${today}`;
    let activeSession =
      userState.accountSessions.get(accountSessionKey) ||
      Array.from(userState.accountSessions.entries()).find(
        ([key, s]) => key.startsWith(`${resolvedAccountId}__`) && s.state === 'LOCKED'
      )?.[1] ||
      (resolvedAccountId === DEFAULT_ACCOUNT_ID
        ? userState.sessions.get(today) || Array.from(userState.sessions.values()).find((s) => s.state === 'LOCKED')
        : null);

    // If no in-memory locked session exists yet, evaluate live shadow state or Firestore for this specific account
    if (!activeSession || activeSession.state !== 'LOCKED') {
      const adminDb = getAdminFirestore();
      if (adminDb) {
        try {
          const accountSnap = await adminDb.doc(`users/${userId}/accountRiskSessions/${accountSessionKey}`).get();
          if (accountSnap.exists) {
            const snapSession = accountSnap.data() as RiskSession;
            if (snapSession && snapSession.state === 'LOCKED') {
              activeSession = snapSession;
              userState.accountSessions.set(accountSessionKey, activeSession);
            }
          } else if (resolvedAccountId === DEFAULT_ACCOUNT_ID) {
            const legacySnap = await adminDb.doc(`users/${userId}/riskSessions/${today}`).get();
            if (legacySnap.exists) {
              const legacySession = legacySnap.data() as RiskSession;
              if (legacySession && legacySession.state === 'LOCKED') {
                activeSession = legacySession;
                userState.sessions.set(today, activeSession);
              }
            }
          }
        } catch {}
      }

      if ((!activeSession || activeSession.state !== 'LOCKED') && resolvedAccountId === DEFAULT_ACCOUNT_ID) {
        try {
          const liveAdapter = BrokerService.getLiveAdapter();
          const connStatus = await liveAdapter.getConnectionStatus(userId);
          if (connStatus.status === 'CONNECTED' && connStatus.authenticated) {
            const shadowResult = await ShadowRiskService.evaluateLiveShadow(userId);
            if (shadowResult.expectedState === 'LOCKED') {
              activeSession = {
                tradingDate: today,
                userId,
                state: 'LOCKED',
                isBreached: true,
                lockedAt: shadowResult.lockedAt || new Date().toISOString(),
                lockUntil: shadowResult.lockUntil || null,
                currentPnl: shadowResult.grossTradingPnl,
                realisedPnl: 0,
                unrealisedPnl: 0,
                lossLimit: currentConfig.dailyLossLimit,
                warningThreshold1: currentConfig.warningThreshold1,
                warningThreshold2: currentConfig.warningThreshold2,
                lastEvaluatedAt: shadowResult.evaluatedAt,
                reason: shadowResult.reason,
              };
            }
          }
        } catch {
          // Fall through
        }
      }
    }

    const isLocked = activeSession?.state === 'LOCKED';
    const isLockActive =
      isLocked &&
      (!activeSession?.lockUntil || new Date(activeSession.lockUntil).getTime() > Date.now());

    console.log(`[DEBUG saveConfig] userId=${userId} accountId=${resolvedAccountId} isLocked=${isLocked} isLockActive=${isLockActive} activeSessionState=${activeSession?.state} currentLimit=${currentConfig?.dailyLossLimit} sanitizedLimit=${sanitized.dailyLossLimit}`);

    if (isLockActive) {
      const isLimitAttempted = sanitized.dailyLossLimit !== currentConfig.dailyLossLimit;
      const isLockoutAttempted =
        sanitized.lockDurationMinutes !== currentConfig.lockDurationMinutes ||
        sanitized.lockDurationType !== currentConfig.lockDurationType;

      if (isLimitAttempted || isLockoutAttempted) {
        console.warn(`[RiskStore] Attempted RiskConfig mutation rejected while LOCKED for user ${userId}`);
        return {
          success: false,
          code: 'RISK_CONFIG_LOCKED',
          errors: [
            'RISK_CONFIG_LOCKED: Daily loss limit, lock duration, and lock duration type cannot be modified while Trading Firewall circuit breaker is LOCKED.',
          ],
        };
      }
    }

    const adminDb = getAdminFirestore();
    const isProduction = process.env.NODE_ENV === 'production';
    const isMock = isMockStoreEnabled();

    if (isProduction && !adminDb && !isMock) {
      throw new Error(`FIRESTORE_PERSISTENCE_FAILURE: Authoritative Firestore is unavailable in production for user ${userId}.`);
    }

    if (adminDb) {
      try {
        const batch = adminDb.batch();
        const accountConfigDocRef = adminDb.doc(`users/${userId}/accountRiskConfigs/${resolvedAccountId}`);
        const legacyDocRef = adminDb.doc(`users/${userId}/riskConfig/config`);

        batch.set(accountConfigDocRef, sanitized, { merge: true });
        if (resolvedAccountId === DEFAULT_ACCOUNT_ID) {
          batch.set(legacyDocRef, sanitized, { merge: true });
        }

        await batch.commit();
      } catch (err) {
        console.error(`[RiskStore] saveConfig dual-write to Firestore failed:`, err);
        throw new Error(
          `FIRESTORE_PERSISTENCE_FAILURE: Failed to persist riskConfig to Firestore: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      }
    }

    // Mutate in-memory cache ONLY AFTER authoritative Firestore persistence succeeds
    if (resolvedAccountId === DEFAULT_ACCOUNT_ID) {
      userState.config = sanitized;
    }
    userState.accountConfigs.set(resolvedAccountId, sanitized);
    userState.loadedFromFirestore = true;

    const event: RiskEvent = {
      userId,
      type: 'CONFIG_UPDATED',
      message: `Risk config updated: Daily Loss Limit ₹${sanitized.dailyLossLimit.toLocaleString(
        'en-IN'
      )}, Threshold 1: ${sanitized.warningThreshold1}%, Threshold 2: ${
        sanitized.warningThreshold2
      }%, Lock: ${sanitized.lockDurationMinutes}m, Enabled: ${sanitized.enabled}`,
      timestamp: new Date().toISOString(),
    };
    userState.events.push(event);

    console.log(
      `[RiskStore] Config successfully updated for user ${userId} [account ${resolvedAccountId}]: Limit ₹${sanitized.dailyLossLimit}, Lock ${sanitized.lockDurationMinutes}m`
    );

    // If an active session is currently LOCKED, verify that the lock is preserved
    const currentSession = userState.accountSessions.get(accountSessionKey) || userState.sessions.get(today);
    if (currentSession && currentSession.state === 'LOCKED') {
      console.log(
        `[RiskStore] Active lock preserved for user ${userId} on date ${today} until ${currentSession.lockUntil}`
      );
    }

    return { success: true, config: sanitized };
  }

  /**
   * Phase 5 Authoritative Risk Evaluation: Evaluates a PnlResult against the Risk Engine.
   * Backed by Firestore ACID transactions with dual-write to accountRiskSessions and legacy riskSessions.
   */
  public static async evaluatePnlResult(
    userId: string,
    pnlResult: PnlResult,
    evaluationTime: Date = new Date(),
    configOverride?: RiskConfig,
    accountId?: string
  ): Promise<RiskEvaluationResult> {
    const userState = this.getOrCreateUserState(userId);
    const tradingDate = pnlResult.tradingDate || getTradingDateKolkata(evaluationTime);
    const resolvedAccountId = await this.resolveAccountId(userId, accountId);
    const accountSessionKey = `${resolvedAccountId}__${tradingDate}`;

    // 1. Prioritize server-authoritative Firebase Admin SDK transaction
    const adminDb = getAdminFirestore();
    const isProduction = process.env.NODE_ENV === 'production';
    const isMock = isMockStoreEnabled();

    if (isProduction && !adminDb && !isMock) {
      throw new Error('FIRESTORE_PERSISTENCE_FAILURE: Authoritative Firestore is unavailable in production.');
    }

    if (adminDb) {
      const sessionDocRef = adminDb.doc(`users/${userId}/riskSessions/${tradingDate}`);
      const accountSessionDocRef = adminDb.doc(`users/${userId}/accountRiskSessions/${accountSessionKey}`);
      const configDocRef = adminDb.doc(`users/${userId}/riskConfig/config`);
      const accountConfigDocRef = adminDb.doc(`users/${userId}/accountRiskConfigs/${resolvedAccountId}`);

      try {
        const txResult = await adminDb.runTransaction(async (transaction) => {
          const [sessionSnap, accountSessionSnap, configSnap, accountConfigSnap] = await Promise.all([
            transaction.get(sessionDocRef),
            transaction.get(accountSessionDocRef),
            transaction.get(configDocRef),
            transaction.get(accountConfigDocRef),
          ]);

          let activeConfig: RiskConfig;
          if (configOverride) {
            activeConfig = configOverride;
          } else if (accountConfigSnap.exists) {
            activeConfig = accountConfigSnap.data() as RiskConfig;
          } else if (configSnap.exists) {
            activeConfig = configSnap.data() as RiskConfig;
          } else {
            activeConfig = userState.accountConfigs.get(resolvedAccountId) || userState.config;
          }

          let existingSession: RiskSession | null = null;
          if (accountSessionSnap.exists) {
            existingSession = accountSessionSnap.data() as RiskSession;
          } else if (sessionSnap.exists) {
            existingSession = sessionSnap.data() as RiskSession;
          } else {
            existingSession =
              userState.accountSessions.get(accountSessionKey) ||
              userState.sessions.get(tradingDate) ||
              null;
          }

          const evaluation = RiskEngine.evaluate({
            userId,
            config: activeConfig,
            pnlResult,
            currentSession: existingSession,
            evaluationTime,
          });

          // Dual-write atomic transaction: write to account-level session.
          // Dual-write to legacy session doc users/{userId}/riskSessions/{tradingDate}
          // ONLY for the default Zerodha account (preserving legacy Zerodha invariants and isolation for non-default accounts).
          transaction.set(accountSessionDocRef, evaluation.session);
          if (resolvedAccountId === DEFAULT_ACCOUNT_ID) {
            transaction.set(sessionDocRef, evaluation.session);
          }

          // Record transition events in Firestore transaction
          for (const event of evaluation.transitionEvents) {
            const eventRef = adminDb.collection(`users/${userId}/riskEvents`).doc();
            transaction.set(eventRef, event);
          }

          return evaluation;
        });

        // Synchronize in-memory cache with committed transaction
        userState.accountSessions.set(accountSessionKey, txResult.session);
        if (resolvedAccountId === DEFAULT_ACCOUNT_ID) {
          userState.sessions.set(tradingDate, txResult.session);
        }
        for (const event of txResult.transitionEvents) {
          userState.events.push(event);
        }
        return txResult;
      } catch (err) {
        console.error('[RiskStore] evaluatePnlResult Admin transaction failed:', err);
        throw new Error(
          `FIRESTORE_PERSISTENCE_FAILURE: Authoritative RiskSession evaluation failed to persist to Firestore: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      }
    }

    // In-memory server-authoritative evaluation (strictly preserved for unit test runner / mock store)
    // Account isolation: use account-specific session; fallback to legacy session only for default account
    const existingSession =
      userState.accountSessions.get(accountSessionKey) ||
      (resolvedAccountId === DEFAULT_ACCOUNT_ID ? userState.sessions.get(tradingDate) : null) ||
      null;
    const activeConfig =
      configOverride ||
      userState.accountConfigs.get(resolvedAccountId) ||
      userState.config;

    const result = RiskEngine.evaluate({
      userId,
      config: activeConfig,
      pnlResult,
      currentSession: existingSession,
      evaluationTime,
    });

    userState.accountSessions.set(accountSessionKey, result.session);
    if (resolvedAccountId === DEFAULT_ACCOUNT_ID) {
      userState.sessions.set(tradingDate, result.session);
    }

    for (const event of result.transitionEvents) {
      userState.events.push(event);
      console.log(`[RiskStore] Transition Event [${event.type}] for user ${userId}: ${event.message}`);
    }

    return result;
  }

  /**
   * Phase 5 Pipeline:
   * BrokerService.getNormalizedPositions() -> PnlEngine.calculate() -> RiskEngine.evaluate() -> RiskSession
   * Guarantees server-side calculation without trusting client P&L inputs.
   */
  public static async evaluateFromPositions(
    userId: string,
    evaluationTime: Date = new Date(),
    accountId?: string
  ): Promise<RiskEvaluationResult> {
    const config = await this.getConfig(userId, accountId);
    const positions = await BrokerService.getNormalizedPositions();
    const pnlResult = PnlEngine.calculate(positions, config, evaluationTime);
    return await this.evaluatePnlResult(userId, pnlResult, evaluationTime, undefined, accountId);
  }

  /**
   * Backward-compatible evaluation endpoint for numeric P&L (used by Phase 1/2 tests & simulated inputs).
   */
  public static async evaluatePnl(
    userId: string,
    pnl: number,
    evaluationTime: Date = new Date(),
    accountId?: string
  ): Promise<RiskEvaluationResult> {
    const config = await this.getConfig(userId, accountId);
    const tradingDate = getTradingDateKolkata(evaluationTime);
    const syntheticPnlResult: PnlResult = {
      tradingDate,
      realisedPnl: pnl,
      unrealisedPnl: 0,
      totalPnl: pnl,
      includedRealisedPnl: config.includeRealisedPnl ? pnl : 0,
      includedUnrealisedPnl: 0,
      grossTradingPnl: config.includeRealisedPnl ? pnl : 0,
      fnoPositionCount: 1,
      totalPositionCount: 1,
      positions: [],
      source: 'SYNTHETIC_SIMULATION',
      calculatedAt: evaluationTime.toISOString(),
    };

    return await this.evaluatePnlResult(userId, syntheticPnlResult, evaluationTime, undefined, accountId);
  }

  public static async getSession(
    userId: string,
    tradingDate?: string,
    accountId?: string
  ): Promise<RiskSession> {
    const userState = this.getOrCreateUserState(userId);
    const date = tradingDate || getTradingDateKolkata(new Date());
    const resolvedAccountId = await this.resolveAccountId(userId, accountId);
    const accountSessionKey = `${resolvedAccountId}__${date}`;

    let session = userState.accountSessions.get(accountSessionKey) || (resolvedAccountId === DEFAULT_ACCOUNT_ID ? userState.sessions.get(date) : undefined);

    if (!session) {
      // 1. Try to load from Firestore via Firebase Admin SDK
      const adminDb = getAdminFirestore();
      const isProduction = process.env.NODE_ENV === 'production';
      const isMock = isMockStoreEnabled();

      if (isProduction && !adminDb && !isMock) {
        throw new Error(`FIRESTORE_READ_FAILURE: Authoritative Firestore is unavailable in production for user ${userId}.`);
      }

      if (adminDb) {
        try {
          const accountDocRef = adminDb.doc(`users/${userId}/accountRiskSessions/${accountSessionKey}`);
          const legacyDocRef = adminDb.doc(`users/${userId}/riskSessions/${date}`);
          const [accountSnap, legacySnap] = await Promise.all([
            accountDocRef.get(),
            resolvedAccountId === DEFAULT_ACCOUNT_ID ? legacyDocRef.get() : Promise.resolve({ exists: false } as any)
          ]);

          if (accountSnap.exists) {
            session = accountSnap.data() as RiskSession;
            userState.accountSessions.set(accountSessionKey, session);
            if (resolvedAccountId === DEFAULT_ACCOUNT_ID) {
              userState.sessions.set(date, session);
            }
          } else if (resolvedAccountId === DEFAULT_ACCOUNT_ID && legacySnap.exists) {
            session = legacySnap.data() as RiskSession;
            userState.sessions.set(date, session);
            userState.accountSessions.set(accountSessionKey, session);
          }
        } catch (err) {
          console.error(`[RiskStore] getSession from Firestore failed for user ${userId}:`, err);
          throw new Error(
            `FIRESTORE_READ_FAILURE: Failed to read riskSession from Firestore for user ${userId}: ${
              err instanceof Error ? err.message : String(err)
            }`
          );
        }
      }
    }

    if (!session || (session.state === 'MARKET_CLOSED' && !isNseMarketClosed())) {
      // Evaluate from current positions
      const evalResult = await this.evaluateFromPositions(userId, new Date(), resolvedAccountId);
      session = evalResult.session;
    }

    return { ...session };
  }

  public static async getLockStatus(
    userId: string,
    accountId?: string,
    tradingDate?: string
  ): Promise<{
    state: string;
    locked: boolean;
    isBreached: boolean;
    tradingDate: string;
    lockedAt: string | null;
    lockUntil: string | null;
    remainingSeconds: number;
    reason: string | null;
    accountId?: string;
  }> {
    const now = new Date();
    const resolvedAccountId = await this.resolveAccountId(userId, accountId);
    const session = await this.getSession(userId, tradingDate, resolvedAccountId);
    const isLocked = session.state === 'LOCKED';

    let remainingSeconds = 0;
    if (isLocked && session.lockUntil) {
      const lockUntilDate = new Date(session.lockUntil);
      remainingSeconds = Math.max(0, Math.floor((lockUntilDate.getTime() - now.getTime()) / 1000));
    }

    return {
      state: session.state,
      locked: isLocked,
      isBreached: session.isBreached,
      tradingDate: session.tradingDate,
      lockedAt: session.lockedAt,
      lockUntil: session.lockUntil,
      remainingSeconds,
      reason: session.reason,
      accountId: resolvedAccountId,
    };
  }

  public static async getAuditEvents(userId: string): Promise<RiskEvent[]> {
    const userState = this.getOrCreateUserState(userId);
    const adminDb = getAdminFirestore();
    if (adminDb) {
      try {
        const collRef = adminDb.collection(`users/${userId}/riskEvents`);
        const snap = await collRef.orderBy('timestamp', 'desc').limit(100).get();
        const loadedEvents: RiskEvent[] = [];
        snap.forEach((docSnap) => {
          loadedEvents.push(docSnap.data() as RiskEvent);
        });
        loadedEvents.reverse();
        
        const existingKeys = new Set(userState.events.map(e => `${e.timestamp}_${e.message}`));
        for (const ev of loadedEvents) {
          const key = `${ev.timestamp}_${ev.message}`;
          if (!existingKeys.has(key)) {
            userState.events.push(ev);
            existingKeys.add(key);
          }
        }
        userState.events.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
      } catch (err) {
        console.error(`[RiskStore] getAuditEvents from Firestore failed:`, err);
      }
    }
    return [...userState.events];
  }

  public static recordEvent(
    userId: string,
    eventInput: { type: RiskEvent['type']; message: string; timestamp?: string }
  ): void {
    const userState = this.getOrCreateUserState(userId);
    const event: RiskEvent = {
      userId,
      type: eventInput.type,
      message: eventInput.message,
      timestamp: eventInput.timestamp || new Date().toISOString(),
    };
    userState.events.push(event);

    const adminDb = getAdminFirestore();
    if (adminDb) {
      adminDb.collection(`users/${userId}/riskEvents`).add(event)
        .catch((err) => {
          console.error(`[RiskStore] recordEvent to Firestore failed:`, err);
        });
    }
  }

  /**
   * Reset session back to baseline state (used for Demo Reset).
   */
  public static async resetSession(userId: string, accountId?: string): Promise<RiskSession> {
    const userState = this.getOrCreateUserState(userId);
    const today = getTradingDateKolkata(new Date());
    const resolvedAccountId = await this.resolveAccountId(userId, accountId);
    const accountSessionKey = `${resolvedAccountId}__${today}`;

    userState.sessions.delete(today);
    userState.accountSessions.delete(accountSessionKey);

    const adminDb = getAdminFirestore();
    if (adminDb) {
      try {
        const batch = adminDb.batch();
        const sessionDocRef = adminDb.doc(`users/${userId}/riskSessions/${today}`);
        const accountSessionDocRef = adminDb.doc(`users/${userId}/accountRiskSessions/${accountSessionKey}`);

        batch.delete(sessionDocRef);
        batch.delete(accountSessionDocRef);

        await batch.commit();
      } catch (err) {
        console.error(`[RiskStore] resetSession Firestore delete failed:`, err);
        throw new Error(`FIRESTORE_PERSISTENCE_FAILURE: Failed to delete riskSession from Firestore: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    const evalResult = await this.evaluateFromPositions(userId, new Date(), resolvedAccountId);
    return evalResult.session;
  }

  /**
   * Reset store (used for test isolation)
   */
  public static reset() {
    this.userStates.clear();
  }
}
