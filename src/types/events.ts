export type RiskEventType =
  | 'CONFIG_UPDATED'
  | 'RISK_WARNING'
  | 'RISK_WARNING_70'
  | 'RISK_WARNING_90'
  | 'LOSS_LIMIT_BREACHED'
  | 'TRADING_LOCK_CREATED'
  | 'TRADING_LOCK_EXPIRED'
  | 'UNRESOLVED_BREACH_RELOCKED'
  | 'STALE_DATA_DETECTED'
  | 'INVALID_PNL_REJECTED'
  | 'BROKER_DISCONNECTED'
  | 'AUTH_FAILURE'
  | 'API_TIMEOUT'
  | 'BROKER_RECONNECTED'
  | 'DATA_FEED_RECOVERED'
  | 'AUTHORIZED_SESSION_RESET';

export type RiskEventSeverity = 'info' | 'warning' | 'critical' | 'error';

export interface RiskEventMetrics {
  lossAmount?: number;
  dailyLossLimit?: number;
  lossUtilizedPercent?: number;
  currentPnl?: number;
  fnoPositionCount?: number;
}

export interface RiskEvent {
  id?: string;
  userId: string;
  accountId?: string;
  broker?: string;
  type: RiskEventType;
  severity?: RiskEventSeverity;
  message: string;
  timestamp: string;
  idempotencyKey?: string;
  metrics?: RiskEventMetrics;
  details?: Record<string, any>;
  persisted?: boolean;
  persistenceStatus?: 'durable' | 'buffered' | 'failed';
}
