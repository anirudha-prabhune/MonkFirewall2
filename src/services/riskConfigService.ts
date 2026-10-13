import { doc, getDoc, onSnapshot } from 'firebase/firestore';
import { db, getAuthHeaders } from './firebase';
import { RiskConfig, DEFAULT_RISK_CONFIG } from '../types/risk';
import { handleFirestoreError, OperationType } from './firestoreErrors';
import { validateRiskConfig } from '../utils/validation';

const LOCAL_STORAGE_KEY_PREFIX = 'trading_firewall_risk_config_';

export async function getRiskConfig(userId: string, accountId?: string): Promise<RiskConfig> {
  const cacheKey = accountId ? `${userId}_${accountId}` : userId;
  if (userId.startsWith('mock-')) {
    const raw = localStorage.getItem(`${LOCAL_STORAGE_KEY_PREFIX}${cacheKey}`);
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        const val = validateRiskConfig(parsed);
        if (val.valid && val.sanitized) return val.sanitized;
      } catch {
        // fallback
      }
    }
    const initialConfig: RiskConfig = {
      ...DEFAULT_RISK_CONFIG,
      updatedAt: new Date().toISOString(),
    };
    localStorage.setItem(`${LOCAL_STORAGE_KEY_PREFIX}${cacheKey}`, JSON.stringify(initialConfig));
    return initialConfig;
  }

  // 1. Fetch via authenticated Server API with accountId
  try {
    const headers = await getAuthHeaders({
      'x-user-id': userId,
      ...(accountId ? { 'x-account-id': accountId } : {}),
    });
    const url = `/api/risk/config${accountId ? `?accountId=${encodeURIComponent(accountId)}` : ''}`;
    const res = await fetch(url, { headers });
    if (res.ok) {
      const data = await res.json();
      const val = validateRiskConfig(data);
      if (val.valid && val.sanitized) {
        return val.sanitized;
      }
    }
  } catch {
    // Fallback to read-only Firestore snapshot
  }

  const path = accountId ? `users/${userId}/accountRiskConfigs/${accountId}` : `users/${userId}/riskConfig/config`;
  try {
    const configDocRef = doc(db, 'users', userId, accountId ? 'accountRiskConfigs' : 'riskConfig', accountId || 'config');
    const snapshot = await getDoc(configDocRef);

    if (snapshot.exists()) {
      const data = snapshot.data() as RiskConfig;
      const validation = validateRiskConfig(data);
      if (validation.valid && validation.sanitized) {
        return validation.sanitized;
      }
    }

    return {
      ...DEFAULT_RISK_CONFIG,
      updatedAt: new Date().toISOString(),
    };
  } catch (error) {
    handleFirestoreError(error, OperationType.GET, path);
    return {
      ...DEFAULT_RISK_CONFIG,
      updatedAt: new Date().toISOString(),
    };
  }
}

export async function saveRiskConfig(
  userId: string,
  newConfig: Partial<RiskConfig>,
  accountId?: string
): Promise<RiskConfig> {
  const cacheKey = accountId ? `${userId}_${accountId}` : userId;
  if (userId.startsWith('mock-')) {
    const current = await getRiskConfig(userId, accountId);
    const combined = {
      ...current,
      ...newConfig,
    };
    const validation = validateRiskConfig(combined);
    if (!validation.valid || !validation.sanitized) {
      throw new Error(validation.errors.join(', '));
    }
    const sanitized = validation.sanitized;
    localStorage.setItem(`${LOCAL_STORAGE_KEY_PREFIX}${cacheKey}`, JSON.stringify(sanitized));
    window.dispatchEvent(new CustomEvent('sandbox-risk-config-updated', { detail: sanitized }));
    return sanitized;
  }

  // Production: All RiskConfig mutations MUST go through authenticated server API
  const headers = await getAuthHeaders({
    'Content-Type': 'application/json',
    'x-user-id': userId,
    ...(accountId ? { 'x-account-id': accountId } : {}),
  });

  const url = `/api/risk/config${accountId ? `?accountId=${encodeURIComponent(accountId)}` : ''}`;
  const response = await fetch(url, {
    method: 'PUT',
    headers,
    body: JSON.stringify({ ...newConfig, ...(accountId ? { accountId } : {}) }),
  });

  const data = await response.json();

  if (!response.ok || !data.success) {
    const errorMsg =
      data.errors?.join(', ') || data.message || data.error || 'Failed to update risk parameters on server';
    throw new Error(errorMsg);
  }

  return data.config;
}

export function subscribeRiskConfig(
  userId: string,
  onUpdate: (config: RiskConfig) => void,
  onError?: (err: Error) => void,
  accountId?: string
): () => void {
  if (userId.startsWith('mock-')) {
    getRiskConfig(userId, accountId).then(onUpdate);
    const listener = (e: Event) => {
      getRiskConfig(userId, accountId).then(onUpdate);
    };
    window.addEventListener('sandbox-risk-config-updated', listener);
    return () => window.removeEventListener('sandbox-risk-config-updated', listener);
  }

  let active = true;
  const poll = async () => {
    if (!active) return;
    try {
      const cfg = await getRiskConfig(userId, accountId);
      if (active) onUpdate(cfg);
    } catch (err) {
      if (onError && err instanceof Error) onError(err);
    }
  };

  poll();
  const interval = setInterval(poll, 4000);

  // Firestore realtime snapshot listener
  const path = accountId ? `users/${userId}/accountRiskConfigs/${accountId}` : `users/${userId}/riskConfig/config`;
  const configDocRef = doc(db, 'users', userId, accountId ? 'accountRiskConfigs' : 'riskConfig', accountId || 'config');
  const unsubscribeFirestore = onSnapshot(
    configDocRef,
    (snapshot) => {
      if (snapshot.exists() && active) {
        const data = snapshot.data() as RiskConfig;
        const validation = validateRiskConfig(data);
        if (validation.valid && validation.sanitized) {
          onUpdate(validation.sanitized);
        }
      }
    },
    (error) => {
      if (onError) onError(error);
    }
  );

  return () => {
    active = false;
    clearInterval(interval);
    unsubscribeFirestore();
  };
}
