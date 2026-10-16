import { PnlResult } from '../../server/pnl/types';
import { getAuthHeaders } from './firebase';

export async function fetchGrossPnl(userId?: string, accountId?: string): Promise<PnlResult | null> {
  try {
    const customHeaders: Record<string, string> = {};
    if (userId) customHeaders['x-user-id'] = userId;
    if (accountId) customHeaders['x-account-id'] = accountId;

    const headers = await getAuthHeaders(customHeaders);
    const url = accountId ? `/api/pnl?accountId=${encodeURIComponent(accountId)}` : '/api/pnl';

    const res = await fetch(url, { headers });
    if (res.ok) {
      return await res.json();
    }
  } catch (err) {
    console.warn('Failed to fetch gross P&L from server:', err);
  }
  return null;
}
