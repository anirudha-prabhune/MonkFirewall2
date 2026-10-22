import { doc, getDoc, getDocFromCache, setDoc } from 'firebase/firestore';
import { db } from './firebase';
import { UserProfile, AppUser } from '../types/user';
import { handleFirestoreError, OperationType } from './firestoreErrors';

function isOfflineError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return msg.includes('client is offline') || msg.includes('unavailable') || msg.includes('failed to get document');
}

export async function syncUserProfile(user: AppUser | { uid: string; email?: string | null; displayName?: string | null; photoURL?: string | null }): Promise<UserProfile> {
  const now = new Date().toISOString();

  if (user.uid.startsWith('mock-')) {
    return {
      uid: user.uid,
      email: user.email || 'anirudha.prabhune@gmail.com',
      displayName: user.displayName || 'Demo Trader',
      photoURL: user.photoURL || '',
      createdAt: now,
      lastLoginAt: now,
      isSandbox: true,
    };
  }

  const fallbackProfile: UserProfile = {
    uid: user.uid,
    email: user.email || '',
    displayName: user.displayName || '',
    photoURL: user.photoURL || '',
    createdAt: now,
    lastLoginAt: now,
  };

  const path = `users/${user.uid}`;
  const userDocRef = doc(db, 'users', user.uid);

  try {
    let snapshot;
    try {
      snapshot = await getDoc(userDocRef);
    } catch (getErr) {
      if (isOfflineError(getErr)) {
        console.warn('Firestore client offline during profile sync getDoc; attempting cache fallback');
        try {
          snapshot = await getDocFromCache(userDocRef);
        } catch {
          return fallbackProfile;
        }
      } else {
        throw getErr;
      }
    }

    let profileData: UserProfile;

    if (snapshot && snapshot.exists()) {
      const existing = snapshot.data() as UserProfile;
      profileData = {
        uid: user.uid,
        email: user.email || '',
        displayName: user.displayName || existing.displayName || '',
        photoURL: user.photoURL || existing.photoURL || '',
        createdAt: existing.createdAt || now,
        lastLoginAt: now,
      };
      try {
        await setDoc(userDocRef, profileData, { merge: true });
      } catch (setErr) {
        if (isOfflineError(setErr)) {
          console.warn('Firestore client offline during profile setDoc; returning local profile');
          return profileData;
        }
        throw setErr;
      }
    } else {
      profileData = fallbackProfile;
      try {
        await setDoc(userDocRef, profileData);
      } catch (setErr) {
        if (isOfflineError(setErr)) {
          console.warn('Firestore client offline during profile setDoc; returning local profile');
          return profileData;
        }
        throw setErr;
      }
    }

    return profileData;
  } catch (error) {
    if (isOfflineError(error)) {
      console.warn('Firestore client offline in syncUserProfile; returning fallback profile');
      return fallbackProfile;
    }
    handleFirestoreError(error, OperationType.WRITE, path);
  }
}

export async function getUserProfile(userId: string): Promise<UserProfile | null> {
  if (userId.startsWith('mock-')) {
    return {
      uid: userId,
      email: 'anirudha.prabhune@gmail.com',
      displayName: 'Demo Trader',
      createdAt: new Date().toISOString(),
      lastLoginAt: new Date().toISOString(),
      isSandbox: true,
    };
  }

  const path = `users/${userId}`;
  const userDocRef = doc(db, 'users', userId);
  try {
    let snapshot;
    try {
      snapshot = await getDoc(userDocRef);
    } catch (getErr) {
      if (isOfflineError(getErr)) {
        try {
          snapshot = await getDocFromCache(userDocRef);
        } catch {
          return null;
        }
      } else {
        throw getErr;
      }
    }

    if (snapshot && snapshot.exists()) {
      return snapshot.data() as UserProfile;
    }
    return null;
  } catch (error) {
    if (isOfflineError(error)) {
      console.warn(`getUserProfile offline for ${userId}; returning null`);
      return null;
    }
    handleFirestoreError(error, OperationType.GET, path);
  }
}

