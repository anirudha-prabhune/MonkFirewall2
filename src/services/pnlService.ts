import { PnlResult } from '../../server/pnl/types';
import { getAuthHeaders } from './firebase';

export async function fetchGrossPnl(userId?: string, accountId?: string, broker?: string): Promise<PnlResult | null> {
  try {
    const customHeaders: Record<string, string> = {};
    if (userId) customHeaders['x-user-id'] = userId;
    if (accountId) customHeaders['x-account-id'] = accountId;
    if (broker) customHeaders['x-broker'] = broker;

    const headers = await getAuthHeaders(customHeaders);
    const params = new URLSearchParams();
    if (accountId) params.set('accountId', accountId);
    if (broker) params.set('broker', broker);
    const query = params.toString() ? `?${params.toString()}` : '';
    const url = `/api/pnl${query}`;

    const res = await fetch(url, { headers });
    if (res.ok) {
      return await res.json();
    }
  } catch (err) {
    console.warn('Failed to fetch gross P&L from server:', err);
  }
  return null;
}
