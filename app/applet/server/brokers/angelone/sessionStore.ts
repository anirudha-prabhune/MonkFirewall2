import { EncryptedPayload, CryptoService } from '../../security/crypto';
import { ensureFirebaseAdminInitialized } from '../../auth/session';

export interface PersistedAngelOneSessionDoc {
  provider: 'angelone';
  userId: string;
  clientCode?: string;
  encryptedToken: EncryptedPayload;
  authState: 'AUTHENTICATED' | 'AUTHENTICATION_REQUIRED' | 'AUTHENTICATION_ERROR';
  issuedAt: string;
  expiresAt: string;
  updatedAt: string;
  sessionVersion: number;
}

export interface DecryptedAngelOneSession {
  accessToken: string;
  sessionVersion: number;
  issuedAt: string;
  expiresAt: string;
  clientCode?: string;
  authState: string;
  isExpired: boolean;
}

const DEFAULT_CONNECTION_ID = 'angelone_default';
let useMockStoreForTesting = false;
const inMemoryTestStore = new Map<string, PersistedAngelOneSessionDoc>();

export class AngelOneSessionStore {
  public static enableMockStoreForTesting(enabled: boolean): void {
    useMockStoreForTesting = enabled;
    if (!enabled) {
      inMemoryTestStore.clear();
    }
  }

  public static getSessionDocPath(userId: string, connectionId = DEFAULT_CONNECTION_ID): string {
    return `users/${userId.trim()}/brokerConnections/${connectionId}/runtimeSession/current`;
  }

  private static getAdminFirestore(): any {
    try {
      const app = ensureFirebaseAdminInitialized();
      const { getFirestore } = require('firebase-admin/firestore');
      return getFirestore(app);
    } catch {
      return null;
    }
  }

  public static async saveSession(
    userId: string,
    accessToken: string,
    options: {
      clientCode?: string;
      connectionId?: string;
      validityHours?: number;
    } = {}
  ): Promise<{ sessionVersion: number; expiresAt: string }> {
    if (!userId || !userId.trim()) {
      throw new Error('UserId is required to persist Angel One session');
    }
    if (!accessToken || !accessToken.trim()) {
      throw new Error('Access token is required to persist Angel One session');
    }

    const connectionId = options.connectionId || DEFAULT_CONNECTION_ID;
    const now = new Date();
    const validityHours = options.validityHours || 24;
    const expiryUtc = new Date(now.getTime() + validityHours * 3600 * 1000);

    const encrypted = CryptoService.encrypt(accessToken, userId.trim());
    const docPath = this.getSessionDocPath(userId, connectionId);

    if (!useMockStoreForTesting) {
      const db = this.getAdminFirestore();
      if (!db) {
        throw new Error('Firebase Admin Firestore not initialized');
      }
      try {
        const docRef = db.doc(docPath);
        const result = await db.runTransaction(async (tx: any) => {
          const snap = await tx.get(docRef);
          let sessionVersion = 1;
          if (snap.exists) {
            const current = snap.data() as PersistedAngelOneSessionDoc;
            sessionVersion = (current.sessionVersion || 0) + 1;
          }
          const docData: PersistedAngelOneSessionDoc = {
            provider: 'angelone',
            userId: userId.trim(),
            ...(options.clientCode ? { clientCode: options.clientCode.trim() } : {}),
            encryptedToken: {
              iv: encrypted.iv,
              ciphertext: encrypted.ciphertext,
              tag: encrypted.tag,
              keyVersion: encrypted.keyVersion,
            },
            authState: 'AUTHENTICATED',
            issuedAt: now.toISOString(),
            expiresAt: expiryUtc.toISOString(),
            updatedAt: now.toISOString(),
            sessionVersion,
          };
          tx.set(docRef, docData);
          return { sessionVersion, expiresAt: docData.expiresAt };
        });
        return result;
      } catch (err: any) {
        throw new Error(`Failed to persist Angel One session: ${err?.message || String(err)}`);
      }
    }

    const existing = inMemoryTestStore.get(docPath);
    let sessionVersion = 1;
    if (existing && typeof existing.sessionVersion === 'number') {
      sessionVersion = existing.sessionVersion + 1;
    }
    const docData: PersistedAngelOneSessionDoc = {
      provider: 'angelone',
      userId: userId.trim(),
      ...(options.clientCode ? { clientCode: options.clientCode.trim() } : {}),
      encryptedToken: {
        iv: encrypted.iv,
        ciphertext: encrypted.ciphertext,
        tag: encrypted.tag,
        keyVersion: encrypted.keyVersion,
      },
      authState: 'AUTHENTICATED',
      issuedAt: now.toISOString(),
      expiresAt: expiryUtc.toISOString(),
      updatedAt: now.toISOString(),
      sessionVersion,
    };
    inMemoryTestStore.set(docPath, docData);
    return { sessionVersion, expiresAt: docData.expiresAt };
  }

  public static async loadSession(
    userId: string,
    options: {
      connectionId?: string;
      evaluationTime?: Date;
    } = {}
  ): Promise<DecryptedAngelOneSession | null> {
    if (!userId || !userId.trim()) {
      return null;
    }
    const connectionId = options.connectionId || DEFAULT_CONNECTION_ID;
    const now = options.evaluationTime || new Date();
    const docPath = this.getSessionDocPath(userId, connectionId);
    let docData: PersistedAngelOneSessionDoc | null = null;

    if (!useMockStoreForTesting) {
      const db = this.getAdminFirestore();
      if (!db) {
        return null;
      }
      try {
        const snap = await db.doc(docPath).get();
        if (snap.exists) {
          docData = snap.data() as PersistedAngelOneSessionDoc;
        }
      } catch {
        return null;
      }
    } else {
      docData = inMemoryTestStore.get(docPath) || null;
    }

    if (!docData) {
      return null;
    }

    if (docData.authState !== 'AUTHENTICATED') {
      return {
        accessToken: '',
        sessionVersion: docData.sessionVersion,
        issuedAt: docData.issuedAt,
        expiresAt: docData.expiresAt,
        clientCode: docData.clientCode,
        authState: docData.authState,
        isExpired: false,
      };
    }

    const expiresAtDate = new Date(docData.expiresAt);
    if (isNaN(expiresAtDate.getTime()) || now.getTime() >= expiresAtDate.getTime()) {
      await this.invalidateSession(userId, docData.sessionVersion, connectionId);
      return {
        accessToken: '',
        sessionVersion: docData.sessionVersion,
        issuedAt: docData.issuedAt,
        expiresAt: docData.expiresAt,
        clientCode: docData.clientCode,
        authState: 'AUTHENTICATION_REQUIRED',
        isExpired: true,
      };
    }

    try {
      const accessToken = CryptoService.decrypt(docData.encryptedToken, userId.trim());
      return {
        accessToken,
        sessionVersion: docData.sessionVersion,
        issuedAt: docData.issuedAt,
        expiresAt: docData.expiresAt,
        clientCode: docData.clientCode,
        authState: 'AUTHENTICATED',
        isExpired: false,
      };
    } catch {
      await this.invalidateSession(userId, docData.sessionVersion, connectionId);
      return null;
    }
  }

  public static async invalidateSession(
    userId: string,
    failedSessionVersion?: number,
    connectionId = DEFAULT_CONNECTION_ID
  ): Promise<{ invalidated: boolean; currentVersion?: number }> {
    if (!userId || !userId.trim()) {
      return { invalidated: false };
    }
    const docPath = this.getSessionDocPath(userId, connectionId);
    const now = new Date().toISOString();

    if (!useMockStoreForTesting) {
      const db = this.getAdminFirestore();
      if (!db) {
        return { invalidated: false };
      }
      try {
        const docRef = db.doc(docPath);
        const result = await db.runTransaction(async (tx: any) => {
          const snap = await tx.get(docRef);
          if (!snap.exists) {
            return { invalidated: false };
          }
          const current = snap.data() as PersistedAngelOneSessionDoc;
          const currentVersion = current.sessionVersion;
          if (failedSessionVersion !== undefined && currentVersion !== failedSessionVersion) {
            return { invalidated: false, currentVersion };
          }
          tx.update(docRef, {
            authState: 'AUTHENTICATION_REQUIRED',
            encryptedToken: { iv: '', ciphertext: '', tag: '', keyVersion: 0 },
            updatedAt: now,
          });
          return { invalidated: true, currentVersion };
        });
        return result;
      } catch {
        return { invalidated: false };
      }
    }

    const memCurrent = inMemoryTestStore.get(docPath);
    if (!memCurrent) {
      return { invalidated: false };
    }
    const currentVersion = memCurrent.sessionVersion;
    if (failedSessionVersion !== undefined && currentVersion !== failedSessionVersion) {
      return { invalidated: false, currentVersion };
    }
    memCurrent.authState = 'AUTHENTICATION_REQUIRED';
    memCurrent.encryptedToken = { iv: '', ciphertext: '', tag: '', keyVersion: 0 };
    memCurrent.updatedAt = now;
    return { invalidated: true, currentVersion };
  }
}
