export type RiskState = 'ALLOW' | 'WARNING' | 'LOCKED' | 'MARKET_CLOSED';
export type LockDurationType = 'FIXED' | 'UNTIL_4PM';
export type PolicyExecutionMode = 'ENFORCE' | 'ALERT_ONLY' | 'OBSERVE_ONLY';

export interface RiskConfig {
  dailyLossLimit: number;
  warningThreshold1: number; // e.g. 70 (%)
  warningThreshold2: number; // e.g. 90 (%)
  lockDurationMinutes: number; // e.g. 720 (12 hours)
  lockDurationType?: LockDurationType; // 'FIXED' | 'UNTIL_4PM'
  includeRealisedPnl: boolean;
  includeUnrealisedPnl: boolean;
  enabled: boolean;
  updatedAt?: string;
  executionMode?: PolicyExecutionMode;
  accountId?: string;
  broker?: 'zerodha' | 'angelone' | 'mock';
  scope?: 'ACCOUNT' | 'BROKER' | 'PORTFOLIO';
}

export interface AccountRiskConfig extends RiskConfig {
  accountId: string;
  userId: string;
  broker: 'zerodha' | 'angelone' | 'mock';
  scope: 'ACCOUNT';
  executionMode: PolicyExecutionMode;
}

export interface NormalizedAccountRiskInput {
  userId: string;
  accountId: string;
  broker: 'zerodha' | 'angelone' | 'mock';
  tradingDateKolkata: string;
  realisedPnl: number;
  unrealisedPnl: number;
  grossTradingPnl: number;
  fnoPositionCount: number;
  totalPositionCount: number;
  executionMode: PolicyExecutionMode;
  evaluatedAt: string;
}

export const DEFAULT_RISK_CONFIG: RiskConfig = {
  dailyLossLimit: 10000,
  warningThreshold1: 70,
  warningThreshold2: 90,
  lockDurationMinutes: 720,
  lockDurationType: 'FIXED',
  includeRealisedPnl: true,
  includeUnrealisedPnl: true,
  enabled: true,
  executionMode: 'ENFORCE',
  broker: 'zerodha',
  scope: 'ACCOUNT',
};

export const DEFAULT_ACCOUNT_ID = 'acc_mt_zerodha_default';
export const DEFAULT_ANGELONE_ACCOUNT_ID = 'acc_mt_angelone_default';

export const DEFAULT_ANGELONE_RISK_CONFIG: AccountRiskConfig = {
  dailyLossLimit: 10000,
  warningThreshold1: 70,
  warningThreshold2: 90,
  lockDurationMinutes: 720,
  lockDurationType: 'FIXED',
  includeRealisedPnl: true,
  includeUnrealisedPnl: true,
  enabled: true,
  accountId: DEFAULT_ANGELONE_ACCOUNT_ID,
  userId: '',
  broker: 'angelone',
  scope: 'ACCOUNT',
  executionMode: 'OBSERVE_ONLY',
};

export interface RiskSession {
  tradingDate: string; // YYYY-MM-DD in Asia/Kolkata
  userId: string;
  accountId?: string;
  executionMode?: PolicyExecutionMode;
  state: RiskState;
  isBreached: boolean;
  lockedAt: string | null;
  lockUntil: string | null; // Authoritative explicit expiry timestamp
  currentPnl?: number;
  totalPnl?: number;
  realisedPnl?: number;
  unrealisedPnl?: number;
  lossLimit?: number;
  warningThreshold1?: number;
  warningThreshold2?: number;
  lastEvaluatedAt?: string;
  lockExpiresAt?: string | null; // Alias for backward compatibility
  reason?: string | null;
  updatedAt?: string;
  recordedAt?: string;
}

export interface RiskSessionSnapshot {
  tradingDate: string;
  state: RiskState;
  isBreached: boolean;
  lockedAt: string | null;
  lockUntil: string | null;
  reason?: string | null;
  accountId?: string;
}

