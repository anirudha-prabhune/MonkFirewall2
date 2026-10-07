import { getAdminFirestore } from '../brokers/zerodha/sessionStore';
import { RiskConfig, DEFAULT_RISK_CONFIG } from '../../src/types/risk';
import {
  RiskEngine,
  RiskSession,
  RiskEvent,
  RiskEvaluationResult,
  getTradingDateKolkata,
} from './engine';
import { validateRiskConfig } from './validation';
import { PnlResult } from '../pnl/types';
import { PnlEngine } from '../pnl/engine';
import { BrokerService } from '../brokers/service';
import { ShadowRiskService } from './shadowRiskService';

/**
 * Server-authoritative Risk Store and Session Manager (Phase 5).
 *
 * Guarantees:
 * - Backed by Firestore ACID transactions (runTransaction) for state transitions & persistence
 * - Consumes PnlResult directly from Phase 4 PnlEngine
 * - Server evaluates PnlResult from normalized positions; does NOT trust client-submitted P&L
 * - Thread-safe atomic evaluation preventing concurrent lock creation race conditions
 * - Preserves existing active lock when configuration is modified or disabled
 * - Structured server logging for risk transitions, lock creation, expiry, and config updates
 * - Excludes all broker secrets from logs
 */

interface UserRiskState {
  config: RiskConfig;
  sessions: Map<string, RiskSession>; // tradingDate -> RiskSession
  events: RiskEvent[];
  loadedFromFirestore?: boolean;
}

export class ServerRiskStore {
  private static userStates = new Map<string, UserRiskState>();

  private static getOrCreateUserState(userId: string): UserRiskState {
    let state = this.userStates.get(userId);
    if (!state) {
      state = {
        config: { ...DEFAULT_RISK_CONFIG, updatedAt: new Date().toISOString() },
        sessions: new Map(),
        events: [],
        loadedFromFirestore: false,
      };
      this.userStates.set(userId, state);
    }
    return state;
  }

  public static async getConfig(userId: string): Promise<RiskConfig> {
    const userState = this.getOrCreateUserState(userId);
    if (!userState.loadedFromFirestore) {
      const adminDb = getAdminFirestore();
      if (adminDb) {
        try {
          const docRef = adminDb.doc(`users/${userId}/riskConfig/config`);
          const snap = await docRef.get();
          if (snap.exists) {
            const raw = snap.data();
            const validation = validateRiskConfig(raw);
            if (validation.valid && validation.sanitized) {
              userState.config = validation.sanitized;
            }
          }
        } catch (err) {
          console.error(`[RiskStore] getConfig from Firestore failed:`, err);
        } finally {
          userState.loadedFromFirestore = true;
        }
      } else {
        userState.loadedFromFirestore = true;
      }
    }
    return { ...userState.config };
  }

  public static async saveConfig(
    userId: string,
    rawInput: any
  ): Promise<{ success: boolean; config?: RiskConfig; errors?: string[]; code?: string }> {
    const validation = validateRiskConfig(rawInput);
    if (!validation.valid || !validation.sanitized) {
      console.warn(`[RiskStore] Config validation failed for user ${userId}:`, validation.errors);
      return { success: false, errors: validation.errors };
    }

    const userState = this.getOrCreateUserState(userId);
    const currentConfig = userState.config;
    const sanitized = validation.sanitized;

    // Phase 11C: LOCKED Config Immutability Guard
    const today = getTradingDateKolkata(new Date());
    let activeSession = userState.sessions.get(today) || Array.from(userState.sessions.values()).find((s) => s.state === 'LOCKED');

    // If no in-memory locked session exists yet, evaluate live shadow state or Firestore
    if (!activeSession || activeSession.state !== 'LOCKED') {
      const adminDb = getAdminFirestore();
      if (adminDb) {
        try {
          const snap = await adminDb.doc(`users/${userId}/riskSessions/${today}`).get();
          if (snap.exists) {
            const firestoreSession = snap.data() as RiskSession;
            if (firestoreSession && firestoreSession.state === 'LOCKED') {
              activeSession = firestoreSession;
              userState.sessions.set(today, activeSession);
            }
          }
        } catch {}
      }

      if (!activeSession || activeSession.state !== 'LOCKED') {
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

    userState.config = sanitized;
    userState.loadedFromFirestore = true;

    const adminDb = getAdminFirestore();
    if (adminDb) {
      try {
        const docRef = adminDb.doc(`users/${userId}/riskConfig/config`);
        await docRef.set(sanitized, { merge: true });
      } catch (err) {
        console.error(`[RiskStore] saveConfig to Firestore failed:`, err);
        throw new Error(`FIRESTORE_PERSISTENCE_FAILURE: Failed to persist riskConfig to Firestore: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

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
      `[RiskStore] Config successfully updated for user ${userId}: Limit ₹${sanitized.dailyLossLimit}, Lock ${sanitized.lockDurationMinutes}m`
    );

    // If an active session is currently LOCKED, verify that the lock is preserved
    const currentSession = userState.sessions.get(today);
    if (currentSession && currentSession.state === 'LOCKED') {
      console.log(
        `[RiskStore] Active lock preserved for user ${userId} on date ${today} until ${currentSession.lockUntil}`
      );
    }

    return { success: true, config: sanitized };
  }

  /**
   * Phase 5 Authoritative Risk Evaluation: Evaluates a PnlResult against the Risk Engine.
   * Backed by Firestore ACID transactions with server-side concurrency serialization.
   */
  public static async evaluatePnlResult(
    userId: string,
    pnlResult: PnlResult,
    evaluationTime: Date = new Date(),
    configOverride?: RiskConfig
  ): Promise<RiskEvaluationResult> {
    const userState = this.getOrCreateUserState(userId);
    const tradingDate = pnlResult.tradingDate || getTradingDateKolkata(evaluationTime);

    // 1. Prioritize server-authoritative Firebase Admin SDK transaction
    const adminDb = getAdminFirestore();
    if (adminDb) {
      const sessionDocRef = adminDb.doc(`users/${userId}/riskSessions/${tradingDate}`);
      const configDocRef = adminDb.doc(`users/${userId}/riskConfig/config`);

      try {
        const txResult = await adminDb.runTransaction(async (transaction) => {
          const [sessionSnap, configSnap] = await Promise.all([
            transaction.get(sessionDocRef),
            transaction.get(configDocRef),
          ]);

          const activeConfig: RiskConfig = configOverride || (configSnap.exists
            ? (configSnap.data() as RiskConfig)
            : userState.config);

          const existingSession: RiskSession | null = sessionSnap.exists
            ? (sessionSnap.data() as RiskSession)
            : userState.sessions.get(tradingDate) || null;

          const evaluation = RiskEngine.evaluate({
            userId,
            config: activeConfig,
            pnlResult,
            currentSession: existingSession,
            evaluationTime,
          });

          // Persist authoritative session in Firestore transaction
          transaction.set(sessionDocRef, evaluation.session);

          // Record transition events in Firestore transaction
          for (const event of evaluation.transitionEvents) {
            const eventRef = adminDb.collection(`users/${userId}/riskEvents`).doc();
            transaction.set(eventRef, event);
          }

          return evaluation;
        });

        // Synchronize in-memory cache with committed transaction
        userState.sessions.set(tradingDate, txResult.session);
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
    const existingSession = userState.sessions.get(tradingDate) || null;
    const activeConfig = configOverride || userState.config;

    const result = RiskEngine.evaluate({
      userId,
      config: activeConfig,
      pnlResult,
      currentSession: existingSession,
      evaluationTime,
    });

    userState.sessions.set(tradingDate, result.session);

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
    evaluationTime: Date = new Date()
  ): Promise<RiskEvaluationResult> {
    const config = await this.getConfig(userId);
    const positions = await BrokerService.getNormalizedPositions();
    const pnlResult = PnlEngine.calculate(positions, config, evaluationTime);
    return await this.evaluatePnlResult(userId, pnlResult, evaluationTime);
  }

  /**
   * Backward-compatible evaluation endpoint for numeric P&L (used by Phase 1/2 tests & simulated inputs).
   */
  public static async evaluatePnl(
    userId: string,
    pnl: number,
    evaluationTime: Date = new Date()
  ): Promise<RiskEvaluationResult> {
    const config = await this.getConfig(userId);
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

    return await this.evaluatePnlResult(userId, syntheticPnlResult, evaluationTime);
  }

  public static async getSession(userId: string, tradingDate?: string): Promise<RiskSession> {
    const userState = this.getOrCreateUserState(userId);
    const date = tradingDate || getTradingDateKolkata(new Date());
    let session = userState.sessions.get(date);

    if (!session) {
      // 1. Try to load from Firestore via Firebase Admin SDK
      const adminDb = getAdminFirestore();
      if (adminDb) {
        try {
          const docRef = adminDb.doc(`users/${userId}/riskSessions/${date}`);
          const snap = await docRef.get();
          if (snap.exists) {
            session = snap.data() as RiskSession;
            userState.sessions.set(date, session);
          }
        } catch (err) {
          console.error(`[RiskStore] getSession from Firestore failed for user ${userId}:`, err);
        }
      }
    }

    if (!session) {
      // Evaluate from current positions
      const evalResult = await this.evaluateFromPositions(userId, new Date());
      session = evalResult.session;
    }

    return { ...session };
  }

  public static async getLockStatus(userId: string): Promise<{
    state: string;
    locked: boolean;
    isBreached: boolean;
    tradingDate: string;
    lockedAt: string | null;
    lockUntil: string | null;
    remainingSeconds: number;
    reason: string | null;
  }> {
    const now = new Date();
    const session = await this.getSession(userId);
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
  public static async resetSession(userId: string): Promise<RiskSession> {
    const userState = this.getOrCreateUserState(userId);
    const today = getTradingDateKolkata(new Date());
    userState.sessions.delete(today);

    const adminDb = getAdminFirestore();
    if (adminDb) {
      try {
        const sessionDocRef = adminDb.doc(`users/${userId}/riskSessions/${today}`);
        await sessionDocRef.delete();
      } catch (err) {
        console.error(`[RiskStore] resetSession Firestore delete failed:`, err);
        throw new Error(`FIRESTORE_PERSISTENCE_FAILURE: Failed to delete riskSession from Firestore: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    const evalResult = await this.evaluateFromPositions(userId, new Date());
    return evalResult.session;
  }

  /**
   * Reset store (used for test isolation)
   */
  public static reset() {
    this.userStates.clear();
  }
}
