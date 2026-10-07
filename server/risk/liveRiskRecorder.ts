/**
 * PHASE 10A — AUTHORITATIVE LIVE RISK STATE RECORDER
 *
 * Connects validated live Zerodha F&O P&L to authoritative RiskSession & riskEvents persistence
 * under the strict control of `liveRiskStateRecordingEnabled`.
 *
 * SAFETY INVARIANTS:
 * 1. Default: liveRiskStateRecordingEnabled = false (production safe; shadow-only by default).
 * 2. When disabled: NEVER mutates RiskSession, emits riskEvents, or triggers lockouts.
 * 3. When enabled: Feeds validated PnlResult directly into ServerRiskStore.evaluatePnlResult
 *    reusing ACID Firestore transactions and existing RiskEngine idempotency.
 * 4. Active locks are strictly preserved; lockUntil is never extended on repeated evaluation.
 * 5. ZERO order placement, modification, cancel, or square-off APIs are ever invoked.
 */

import { LivePnlValidationService } from '../pnl/liveValidationService';
import { ServerRiskStore } from './store';
import { RiskEngine, RiskSession, RiskEvent, RiskEvaluationResult, getTradingDateKolkata } from './engine';
import { PnlResult } from '../pnl/types';
import { RawBrokerPosition, BrokerInstrument } from '../brokers/types';
import { RiskConfig } from '../../src/types/risk';
import { LivePnlValidationResult } from '../pnl/liveValidationTypes';
import { getAdminFirestore } from '../brokers/zerodha/sessionStore';

/**
 * User-scoped in-memory recording state cache and global fallback.
 * STRICTLY FALSE by default for safety.
 */
const userRecordingStates = new Map<string, boolean>();
let globalRecordingFallback = false;

export let liveRiskStateRecordingEnabled = false;

export async function initializeRecordingState(userId?: string): Promise<void> {
  const adminDb = getAdminFirestore();
  if (!adminDb) return;

  if (userId && userId.trim().length > 0 && userId !== 'default_trader') {
    try {
      const docRef = adminDb.doc(`users/${userId}/riskRecording/state`);
      const snap = await docRef.get();
      if (snap.exists) {
        const data = snap.data();
        if (data && typeof data.enabled === 'boolean') {
          userRecordingStates.set(userId, data.enabled);
          console.log(`[LiveRiskRecorder] Restored recording state for ${userId}: ${data.enabled}`);
        }
      }
    } catch (err) {
      console.error(`[LiveRiskRecorder] Failed to load recording state for user ${userId}:`, err);
    }
  } else {
    try {
      const docRef = adminDb.doc('system/recordingState');
      const snap = await docRef.get();
      if (snap.exists) {
        const data = snap.data();
        if (data && typeof data.enabled === 'boolean') {
          globalRecordingFallback = data.enabled;
          liveRiskStateRecordingEnabled = data.enabled;
          console.log(`[LiveRiskRecorder] Restored global recording state from Firestore: ${data.enabled}`);
        }
      }
    } catch (err) {
      console.error('[LiveRiskRecorder] Failed to load recording state from Firestore:', err);
    }
  }
}

// Trigger initial load asynchronously on import
initializeRecordingState().catch(() => {});

export function getLiveRiskStateRecordingEnabled(userId?: string): boolean {
  if (userId && userId.trim().length > 0) {
    if (userRecordingStates.has(userId)) {
      return userRecordingStates.get(userId)!;
    }
    return globalRecordingFallback;
  }
  return Array.from(userRecordingStates.values()).some(Boolean) || globalRecordingFallback;
}

export function setLiveRiskStateRecordingEnabled(enabled: boolean, userId?: string): void {
  if (userId && userId.trim().length > 0) {
    userRecordingStates.set(userId, enabled);
    const adminDb = getAdminFirestore();
    if (adminDb && userId !== 'default_trader') {
      const docRef = adminDb.doc(`users/${userId}/riskRecording/state`);
      docRef
        .set({ enabled, userId, updatedAt: new Date().toISOString() }, { merge: true })
        .then(() => {
          console.log(`[LiveRiskRecorder] Successfully saved user recording state (${userId}): ${enabled}`);
        })
        .catch((err) => {
          console.error(`[LiveRiskRecorder] Failed to save user recording state (${userId}):`, err);
        });
    }
  } else {
    if (!enabled) {
      userRecordingStates.clear();
    }
    globalRecordingFallback = enabled;
  }
  liveRiskStateRecordingEnabled = Array.from(userRecordingStates.values()).some(Boolean) || globalRecordingFallback;
}

export function resetRecordingStates(): void {
  userRecordingStates.clear();
  globalRecordingFallback = false;
  liveRiskStateRecordingEnabled = false;
}

export interface LiveRiskEvaluationOptions {
  injectedPositions?: RawBrokerPosition[];
  injectedInstrumentMap?: Map<number, BrokerInstrument>;
  configOverride?: Partial<RiskConfig>;
  evaluationTime?: Date;
  forceRecord?: boolean; // Used strictly for tests or explicit execution
}

export interface LiveRiskRecordingResult {
  recorded: boolean;
  flagEnabled: boolean;
  state: string;
  isBreached: boolean;
  lossAmount: number;
  grossTradingPnl: number;
  tradingDate: string;
  evaluatedAt: string;
  dataSource: 'ZERODHA_LIVE';
  session?: RiskSession;
  transitionEvents: RiskEvent[];
  pnlResult: PnlResult;
  validationResult: LivePnlValidationResult;
  reason?: string | null;
}

export class LiveRiskRecorder {
  /**
   * Authoritative Live Risk Evaluation & Recording:
   * Real Zerodha P&L → LivePnlValidationService → PnlResult → RiskEngine.evaluate() → RiskSession / riskEvents
   */
  public static async evaluateAndRecordLiveRisk(
    userId: string,
    options?: LiveRiskEvaluationOptions
  ): Promise<LiveRiskRecordingResult> {
    const evaluationTime = options?.evaluationTime || new Date();
    const shouldRecord = options?.forceRecord ?? getLiveRiskStateRecordingEnabled(userId);

    // 1. Retrieve applicable RiskConfig
    let config: RiskConfig;
    if (options?.configOverride) {
      const userConfig = await ServerRiskStore.getConfig(userId);
      config = { ...userConfig, ...options.configOverride };
    } else {
      config = await ServerRiskStore.getConfig(userId);
    }

    // 2. Obtain validated live P&L through the frozen Phase 8 pipeline
    const validationResult = await LivePnlValidationService.validateLivePnl(
      config,
      evaluationTime,
      options?.injectedPositions,
      options?.injectedInstrumentMap,
      userId
    );

    // 3. Construct canonical PnlResult from pipeline output
    const pnlResult: PnlResult = {
      tradingDate: validationResult.tradingDate,
      realisedPnl: validationResult.calculated.realisedPnl,
      unrealisedPnl: validationResult.calculated.unrealisedPnl,
      totalPnl: validationResult.calculated.grossTradingPnl,
      grossTradingPnl: validationResult.calculated.grossTradingPnl,
      dailyRealisedPnl: validationResult.calculated.dailyRealisedPnl,
      dailyUnrealisedPnl: validationResult.calculated.dailyUnrealisedPnl,
      fnoPositionCount: validationResult.calculated.fnoPositionCount,
      totalPositionCount: validationResult.calculated.fnoPositionCount,
      positions: validationResult.positions || [],
      includedRealisedPnl: validationResult.calculated.dailyRealisedPnl,
      includedUnrealisedPnl: validationResult.calculated.dailyUnrealisedPnl,
      source: 'ZERODHA_LIVE',
      calculatedAt: validationResult.timestamp,
    };

    // 4. SAFETY GATE: Authoritative live RiskSession recording and RiskEngine persistence
    // may proceed ONLY when validationState === VALID.
    // STALE_DATA, MISSING_DATA, DISCREPANCY, UNKNOWN_INSTRUMENTS, AUTHENTICATION_REQUIRED, and ERROR
    // must NEVER reach authoritative RiskEngine persistence, mutate RiskSession, or fabricate zero P&L.
    if (validationResult.validationState !== 'VALID') {
      const tradingDate = validationResult.tradingDate || getTradingDateKolkata(evaluationTime);
      const existingSession = await ServerRiskStore.getSession(userId, tradingDate);
      const isBreached = existingSession?.isBreached || existingSession?.state === 'LOCKED';
      const state = existingSession?.state || 'ALLOW';
      const lossAmount = existingSession?.lossAmount ?? 0;
      const grossTradingPnl = existingSession?.currentPnl ?? 0;

      return {
        recorded: false,
        flagEnabled: shouldRecord,
        state,
        isBreached,
        lossAmount,
        grossTradingPnl,
        tradingDate,
        evaluatedAt: evaluationTime.toISOString(),
        dataSource: 'ZERODHA_LIVE',
        session: existingSession,
        transitionEvents: [],
        pnlResult,
        validationResult,
        reason: `Live risk evaluation rejected: validation state is ${validationResult.validationState}`,
      };
    }

    const lossAmount = Math.max(0, -pnlResult.grossTradingPnl);

    // 5. BRANCH: If recording is disabled, evaluate in read-only mode (Zero persistence)
    if (!shouldRecord) {
      const existingSession = await ServerRiskStore.getSession(userId);
      const readOnlyEval = RiskEngine.evaluate({
        userId,
        config,
        pnlResult,
        currentSession: existingSession,
        evaluationTime,
      });

      return {
        recorded: false,
        flagEnabled: false,
        state: readOnlyEval.state,
        isBreached: readOnlyEval.isBreached,
        lossAmount,
        grossTradingPnl: pnlResult.grossTradingPnl,
        tradingDate: validationResult.tradingDate,
        evaluatedAt: evaluationTime.toISOString(),
        dataSource: 'ZERODHA_LIVE',
        session: existingSession,
        transitionEvents: [], // Zero events persisted
        pnlResult,
        validationResult,
        reason: readOnlyEval.reason,
      };
    }

    // 6. BRANCH: If recording is enabled and validationState === VALID, perform authoritative persistence via ServerRiskStore
    const evalResult: RiskEvaluationResult = await ServerRiskStore.evaluatePnlResult(
      userId,
      pnlResult,
      evaluationTime,
      options?.configOverride ? config : undefined
    );

    return {
      recorded: true,
      flagEnabled: true,
      state: evalResult.state,
      isBreached: evalResult.isBreached,
      lossAmount,
      grossTradingPnl: pnlResult.grossTradingPnl,
      tradingDate: evalResult.tradingDate,
      evaluatedAt: evaluationTime.toISOString(),
      dataSource: 'ZERODHA_LIVE',
      session: evalResult.session,
      transitionEvents: evalResult.transitionEvents,
      pnlResult,
      validationResult,
      reason: evalResult.reason,
    };
  }
}
