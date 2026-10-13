import { doc, onSnapshot, getDoc } from 'firebase/firestore';
import { db, getAuthHeaders } from './firebase';
import { RiskSession } from '../types/risk';
import { handleFirestoreError, OperationType } from './firestoreErrors';

/**
 * Client service to read authoritative RiskSession and Lock state with multi-account support.
 */

export async function getAuthoritativeRiskSession(userId: string, accountId?: string): Promise<RiskSession> {
  const headers = await getAuthHeaders({
    'x-user-id': userId,
    ...(accountId ? { 'x-account-id': accountId } : {}),
  });
  const url = `/api/risk${accountId ? `?accountId=${encodeURIComponent(accountId)}` : ''}`;

  if (userId.startsWith('mock-')) {
    try {
      const res = await fetch(url, { headers });
      if (res.ok) {
        return await res.json();
      }
    } catch {
      // Fallback
    }

    const today = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Kolkata',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());

    return {
      tradingDate: today,
      userId,
      state: 'ALLOW',
      isBreached: false,
      lockedAt: null,
      lockUntil: null,
      currentPnl: 0,
      realisedPnl: 0,
      unrealisedPnl: 0,
      lossLimit: 10000,
      warningThreshold1: 70,
      warningThreshold2: 90,
      lastEvaluatedAt: new Date().toISOString(),
      reason: 'Sandbox initial session',
    };
  }

  // Fetch via server authoritative API
  try {
    const res = await fetch(url, { headers });
    if (res.ok) {
      return await res.json();
    }
  } catch (err) {
    console.warn('Could not fetch risk session from server API, falling back to Firestore read:', err);
  }

  // Read from Firestore (Read-Only)
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());

  const subcoll = accountId ? 'accountRiskSessions' : 'riskSessions';
  const docKey = accountId ? `${accountId}__${today}` : today;
  const path = `users/${userId}/${subcoll}/${docKey}`;

  try {
    const sessionDocRef = doc(db, 'users', userId, subcoll, docKey);
    const snapshot = await getDoc(sessionDocRef);
    if (snapshot.exists()) {
      return snapshot.data() as RiskSession;
    }

    // Try fallback to legacy riskSessions/{today} if default account
    if (!accountId || accountId === 'acc_mt_zerodha_default') {
      const legacyRef = doc(db, 'users', userId, 'riskSessions', today);
      const legacySnap = await getDoc(legacyRef);
      if (legacySnap.exists()) {
        return legacySnap.data() as RiskSession;
      }
    }

    return {
      tradingDate: today,
      userId,
      state: 'ALLOW',
      isBreached: false,
      lockedAt: null,
      lockUntil: null,
      currentPnl: 0,
      realisedPnl: 0,
      unrealisedPnl: 0,
      lossLimit: 10000,
      warningThreshold1: 70,
      warningThreshold2: 90,
      lastEvaluatedAt: new Date().toISOString(),
      reason: null,
    };
  } catch (error) {
    handleFirestoreError(error, OperationType.GET, path);
  }
}

export async function getLockStatus(userId: string, accountId?: string): Promise<any> {
  const headers = await getAuthHeaders({
    'x-user-id': userId,
    ...(accountId ? { 'x-account-id': accountId } : {}),
  });
  const url = `/api/lock/status${accountId ? `?accountId=${encodeURIComponent(accountId)}` : ''}`;
  const res = await fetch(url, { headers });
  if (res.ok) {
    return await res.json();
  }
  throw new Error('Failed to fetch lock status');
}

export function subscribeRiskSession(
  userId: string,
  onUpdate: (session: RiskSession) => void,
  accountId?: string
): () => void {
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());

  let active = true;
  const poll = async () => {
    if (!active) return;
    try {
      const session = await getAuthoritativeRiskSession(userId, accountId);
      if (active) onUpdate(session);
    } catch {
      // ignore transient poll errors
    }
  };

  poll();
  const interval = setInterval(poll, 3000);

  let unsubFirestore: (() => void) | null = null;
  if (!userId.startsWith('mock-')) {
    try {
      const subcoll = accountId ? 'accountRiskSessions' : 'riskSessions';
      const docKey = accountId ? `${accountId}__${today}` : today;
      const sessionDocRef = doc(db, 'users', userId, subcoll, docKey);
      unsubFirestore = onSnapshot(
        sessionDocRef,
        (snap) => {
          if (snap.exists() && active) {
            const docData = snap.data() as RiskSession;
            if (docData && (docData.recordedAt || docData.isBreached || docData.state !== 'ALLOW')) {
              onUpdate(docData);
            }
          }
        },
        (error) => {
          // Suppress/ignore permission-denied errors in snapshot listener gracefully
        }
      );
    } catch {
      // ignore
    }
  }

  return () => {
    active = false;
    clearInterval(interval);
    if (unsubFirestore) unsubFirestore();
  };
}
