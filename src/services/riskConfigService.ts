import { doc, getDoc, onSnapshot } from 'firebase/firestore';
import { db, getAuthHeaders } from './firebase';
import { RiskConfig, DEFAULT_RISK_CONFIG } from '../types/risk';
import { handleFirestoreError, OperationType } from './firestoreErrors';
import { validateRiskConfig } from '../../server/risk/validation';

const LOCAL_STORAGE_KEY_PREFIX = 'trading_firewall_risk_config_';

export async function getRiskConfig(userId: string): Promise<RiskConfig> {
  if (userId.startsWith('mock-')) {
    const raw = localStorage.getItem(`${LOCAL_STORAGE_KEY_PREFIX}${userId}`);
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
    localStorage.setItem(`${LOCAL_STORAGE_KEY_PREFIX}${userId}`, JSON.stringify(initialConfig));
    return initialConfig;
  }

  // 1. Fetch via authenticated Server API
  try {
    const headers = await getAuthHeaders({ 'x-user-id': userId });
    const res = await fetch('/api/risk/config', { headers });
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

  const path = `users/${userId}/riskConfig/config`;
  try {
    const configDocRef = doc(db, 'users', userId, 'riskConfig', 'config');
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
  newConfig: Partial<RiskConfig>
): Promise<RiskConfig> {
  if (userId.startsWith('mock-')) {
    const current = await getRiskConfig(userId);
    const combined = {
      ...current,
      ...newConfig,
    };
    const validation = validateRiskConfig(combined);
    if (!validation.valid || !validation.sanitized) {
      throw new Error(validation.errors.join(', '));
    }
    const sanitized = validation.sanitized;
    localStorage.setItem(`${LOCAL_STORAGE_KEY_PREFIX}${userId}`, JSON.stringify(sanitized));
    window.dispatchEvent(new CustomEvent('sandbox-risk-config-updated', { detail: sanitized }));
    return sanitized;
  }

  // Production: All RiskConfig mutations MUST go through authenticated server API
  const headers = await getAuthHeaders({
    'Content-Type': 'application/json',
    'x-user-id': userId,
  });

  const response = await fetch('/api/risk/config', {
    method: 'PUT',
    headers,
    body: JSON.stringify(newConfig),
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
  onError?: (err: Error) => void
): () => void {
  if (userId.startsWith('mock-')) {
    getRiskConfig(userId).then(onUpdate);
    const listener = (e: Event) => {
      const detail = (e as CustomEvent).detail as RiskConfig;
      if (detail) onUpdate(detail);
    };
    window.addEventListener('sandbox-risk-config-updated', listener);
    return () => window.removeEventListener('sandbox-risk-config-updated', listener);
  }

  const path = `users/${userId}/riskConfig/config`;
  const configDocRef = doc(db, 'users', userId, 'riskConfig', 'config');

  return onSnapshot(
    configDocRef,
    (snapshot) => {
      if (snapshot.exists()) {
        const data = snapshot.data() as RiskConfig;
        const val = validateRiskConfig(data);
        if (val.valid && val.sanitized) {
          onUpdate(val.sanitized);
        } else {
          onUpdate(DEFAULT_RISK_CONFIG);
        }
      } else {
        onUpdate(DEFAULT_RISK_CONFIG);
      }
    },
    (error) => {
      if (onError) {
        onError(error);
      }
      handleFirestoreError(error, OperationType.GET, path);
    }
  );
}
