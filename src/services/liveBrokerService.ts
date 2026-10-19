import {
  LiveBrokerStatusResponse,
  LivePositionsResponse,
  MarketDataStatus,
  LiveCapitalResponse,
} from '../../server/brokers/types';
import { getAuthHeaders } from './firebase';

export async function fetchLiveBrokerStatus(userId?: string): Promise<LiveBrokerStatusResponse | null> {
  try {
    const headers = await getAuthHeaders(userId ? { 'x-user-id': userId } : {});

    const res = await fetch('/api/broker/live/status', { headers });
    if (res.ok) {
      return await res.json();
    }
  } catch (err) {
    console.warn('Failed to fetch live broker status:', err);
  }
  return null;
}

export async function fetchLiveCapital(userId?: string, accountId?: string): Promise<LiveCapitalResponse | null> {
  try {
    const customHeaders: Record<string, string> = {};
    if (userId) customHeaders['x-user-id'] = userId;
    if (accountId) customHeaders['x-account-id'] = accountId;

    const headers = await getAuthHeaders(customHeaders);
    const url = accountId ? `/api/broker/live/capital?accountId=${encodeURIComponent(accountId)}` : '/api/broker/live/capital';

    const res = await fetch(url, { headers });
    if (res.ok) {
      return await res.json();
    }
  } catch (err) {
    console.warn('Failed to fetch live capital:', err);
  }
  return null;
}

export async function fetchLivePositions(userId?: string, accountId?: string): Promise<LivePositionsResponse | null> {
  try {
    const customHeaders: Record<string, string> = {};
    if (userId) customHeaders['x-user-id'] = userId;
    if (accountId) customHeaders['x-account-id'] = accountId;

    const headers = await getAuthHeaders(customHeaders);
    const url = accountId ? `/api/broker/live/positions?accountId=${encodeURIComponent(accountId)}` : '/api/broker/live/positions';

    const res = await fetch(url, { headers });
    if (res.ok) {
      return await res.json();
    }
  } catch (err) {
    console.warn('Failed to fetch live positions:', err);
  }
  return null;
}

export async function fetchMarketDataStatus(userId?: string): Promise<MarketDataStatus | null> {
  try {
    const headers = await getAuthHeaders(userId ? { 'x-user-id': userId } : {});

    const res = await fetch('/api/broker/live/market-data/status', { headers });
    if (res.ok) {
      return await res.json();
    }
  } catch (err) {
    console.warn('Failed to fetch market data status:', err);
  }
  return null;
}

/**
 * Phase 8A: Fetches Kite Connect daily login URL from server.
 * The server securely creates the URL using the persistent ZERODHA_API_KEY.
 */
export async function fetchKiteLoginUrl(redirectUrl?: string, userId?: string): Promise<string | null> {
  try {
    const headers = await getAuthHeaders(userId ? { 'x-user-id': userId } : {});

    const defaultRedirect = typeof window !== 'undefined' && window.location?.origin
      ? `${window.location.origin}/api/broker/live/auth/callback`
      : undefined;
    const targetRedirect = redirectUrl || defaultRedirect;

    let url = '/api/broker/live/auth/login';
    if (targetRedirect) {
      url += `?redirect_url=${encodeURIComponent(targetRedirect)}`;
    }

    const res = await fetch(url, { headers });
    if (res.ok) {
      const data = await res.json();
      return data.loginUrl || null;
    }
  } catch (err) {
    console.warn('Failed to fetch Kite login URL:', err);
  }
  return null;
}

/**
 * Phase 8A: Invalidate active runtime session on the server.
 */
export async function disconnectZerodhaSession(userId?: string): Promise<boolean> {
  try {
    const headers = await getAuthHeaders(userId ? { 'x-user-id': userId } : {});

    const res = await fetch('/api/broker/live/auth/disconnect', {
      method: 'POST',
      headers,
    });
    return res.ok;
  } catch (err) {
    console.warn('Failed to disconnect Zerodha session:', err);
    return false;
  }
}

export async function fetchAngelOneStatus(userId?: string, accountId?: string): Promise<LiveBrokerStatusResponse | null> {
  try {
    const customHeaders: Record<string, string> = {};
    if (userId) customHeaders['x-user-id'] = userId;
    if (accountId) customHeaders['x-account-id'] = accountId;
    const headers = await getAuthHeaders(customHeaders);
    const query = accountId ? `?accountId=${encodeURIComponent(accountId)}` : '';
    const res = await fetch(`/api/broker/angelone/live/status${query}`, { headers });
    if (res.ok) {
      return await res.json();
    }
  } catch (err) {
    console.warn('Failed to fetch Angel One status:', err);
  }
  return null;
}

export async function fetchAngelOnePositions(userId?: string, accountId?: string): Promise<LivePositionsResponse | null> {
  try {
    const customHeaders: Record<string, string> = {};
    if (userId) customHeaders['x-user-id'] = userId;
    if (accountId) customHeaders['x-account-id'] = accountId;
    const headers = await getAuthHeaders(customHeaders);
    const query = accountId ? `?accountId=${encodeURIComponent(accountId)}` : '';
    const res = await fetch(`/api/broker/angelone/live/positions${query}`, { headers });
    if (res.ok) {
      return await res.json();
    }
  } catch (err) {
    console.warn('Failed to fetch Angel One positions:', err);
  }
  return null;
}

export async function fetchAngelOneCapital(userId?: string, accountId?: string): Promise<LiveCapitalResponse | null> {
  try {
    const customHeaders: Record<string, string> = {};
    if (userId) customHeaders['x-user-id'] = userId;
    if (accountId) customHeaders['x-account-id'] = accountId;
    const headers = await getAuthHeaders(customHeaders);
    const query = accountId ? `?accountId=${encodeURIComponent(accountId)}` : '';
    const res = await fetch(`/api/broker/angelone/live/capital${query}`, { headers });
    if (res.ok) {
      return await res.json();
    }
  } catch (err) {
    console.warn('Failed to fetch Angel One capital:', err);
  }
  return null;
}

export async function authenticateAngelOneSession(
  credentials: { clientCode: string; password?: string; totp?: string; apiKey?: string },
  userId?: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const headers = await getAuthHeaders(userId ? { 'x-user-id': userId } : {});
    headers['Content-Type'] = 'application/json';
    const res = await fetch('/api/broker/angelone/live/auth/session', {
      method: 'POST',
      headers,
      body: JSON.stringify(credentials),
    });
    const data = await res.json();
    if (res.ok && data.success) {
      return { success: true };
    }
    return { success: false, error: data.error || 'Authentication failed' };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Network error' };
  }
}

export async function disconnectAngelOneSession(userId?: string): Promise<boolean> {
  try {
    const headers = await getAuthHeaders(userId ? { 'x-user-id': userId } : {});
    const res = await fetch('/api/broker/angelone/live/auth/disconnect', {
      method: 'POST',
      headers,
    });
    return res.ok;
  } catch (err) {
    console.warn('Failed to disconnect Angel One session:', err);
    return false;
  }
}

