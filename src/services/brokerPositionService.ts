import { NormalizedPosition, BrokerConnectionStatus } from '../../server/brokers/types';
import { getAuthHeaders } from './firebase';

export interface PositionsResponse {
  dataSource: 'MOCK_DATA' | 'ZERODHA_LIVE' | 'ANGELONE_LIVE';
  count: number;
  positions: NormalizedPosition[];
  validationState?: string;
  marketDataStatus?: string;
}

export async function fetchBrokerStatus(): Promise<BrokerConnectionStatus> {
  try {
    const res = await fetch('/api/broker/status');
    if (res.ok) {
      return await res.json();
    }
  } catch (err) {
    console.warn('Failed to fetch broker status:', err);
  }

  return {
    broker: 'zerodha',
    status: 'CONNECTED',
    isMock: true,
    message: 'Mock Zerodha Adapter (Phase 3 Sandbox)',
    timestamp: new Date().toISOString(),
  };
}

export async function fetchFnoPositions(userId?: string, accountId?: string): Promise<NormalizedPosition[]> {
  try {
    const customHeaders: Record<string, string> = {};
    if (userId) customHeaders['x-user-id'] = userId;
    if (accountId) customHeaders['x-account-id'] = accountId;
    const headers = await getAuthHeaders(customHeaders);

    const query = accountId ? `?accountId=${encodeURIComponent(accountId)}` : '';
    const res = await fetch(`/api/positions/fno${query}`, { headers });
    if (res.ok) {
      const data: PositionsResponse = await res.json();
      return data.positions || [];
    }
  } catch (err) {
    console.warn('Failed to fetch F&O positions:', err);
  }
  return [];
}
