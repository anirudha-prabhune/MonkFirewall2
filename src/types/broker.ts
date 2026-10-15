export type BrokerType = 'zerodha' | 'mock' | 'angelone';

export type BrokerStatus = 'CONNECTED' | 'DISCONNECTED' | 'EXPIRED' | 'ERROR';

export interface BrokerConnection {
  broker: BrokerType;
  status: BrokerStatus;
  userId: string;
  brokerUserId?: string;
  connectedAt?: string;
  lastSyncAt?: string;
}

export interface NormalizedPosition {
  instrumentToken: number;
  exchange: string;
  tradingsymbol: string;
  segment?: string;
  instrumentType?: string;
  product?: string;
  quantity: number;
  averagePrice: number;
  lastPrice: number;
  dayBuyQuantity?: number;
  dayBuyValue?: number;
  daySellQuantity?: number;
  daySellValue?: number;
  realisedPnl?: number;
  unrealisedPnl?: number;
  totalPnl?: number;
}

export interface BrokerAccountCapital {
  broker: 'zerodha' | 'angelone' | 'mock';
  dataSource: 'MOCK_DATA' | 'ZERODHA_LIVE' | 'ANGELONE_LIVE';
  connectionStatus: string;
  netBalance: number | null;
  availableCash: number | null;
  availableTradingMargin: number | null;
  utilizedMargin: number | null;
  withdrawableFunds: number | null;
  currency: string;
  asOf: string;
  isStale: boolean;
  isAfterHours: boolean;
  semanticNote: string;
}

export interface LiveCapitalResponse {
  success: boolean;
  broker: 'zerodha' | 'angelone' | 'mock';
  capital: BrokerAccountCapital | null;
  error?: string;
  timestamp: string;
}

