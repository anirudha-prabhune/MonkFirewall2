import { EncryptedPayload, CryptoService } from '../../security/crypto';
import { getAdminFirestore } from '../zerodha/sessionStore';

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

export interface PersistedAngelOneApiKeyDoc {
  provider: 'angelone';
  userId: string;
  encryptedApiKey: EncryptedPayload;
  updatedAt: string;
}

const DEFAULT_CONNECTION_ID = 'angelone_default';
let useMockStoreForTesting = false;
const inMemoryTestStore = new Map<string, PersistedAngelOneSessionDoc>();
const inMemoryTestApiKeyStore = new Map<string, PersistedAngelOneApiKeyDoc>();

export class AngelOneSessionStore {
  public static enableMockStoreForTesting(enabled: boolean): void {
    useMockStoreForTesting = enabled;
    if (!enabled) {
      inMemoryTestStore.clear();
      inMemoryTestApiKeyStore.clear();
    }
  }

  public static getSessionDocPath(userId: string, connectionId = DEFAULT_CONNECTION_ID): string {
    return `users/${userId.trim()}/brokerConnections/${connectionId}/runtimeSession/current`;
  }

  public static getApiKeyDocPath(userId: string, connectionId = DEFAULT_CONNECTION_ID): string {
    return `users/${userId.trim()}/brokerConnections/${connectionId}/credentials/apiKey`;
  }

  private static getAdminFirestore(): any {
    return getAdminFirestore();
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

  /**
   * Persists an encrypted Angel One SmartAPI API key per user and connection.
   */
  public static async saveApiKey(
    userId: string,
    apiKey: string,
    connectionId = DEFAULT_CONNECTION_ID
  ): Promise<void> {
    if (!userId || !userId.trim()) {
      throw new Error('UserId is required to persist Angel One API key');
    }
    if (!apiKey || !apiKey.trim()) {
      throw new Error('API key is required to persist Angel One API key');
    }

    const trimmedUserId = userId.trim();
    const trimmedApiKey = apiKey.trim();
    const now = new Date().toISOString();
    const encrypted = CryptoService.encrypt(trimmedApiKey, trimmedUserId);
    const docPath = this.getApiKeyDocPath(trimmedUserId, connectionId);

    const docData: PersistedAngelOneApiKeyDoc = {
      provider: 'angelone',
      userId: trimmedUserId,
      encryptedApiKey: {
        iv: encrypted.iv,
        ciphertext: encrypted.ciphertext,
        tag: encrypted.tag,
        keyVersion: encrypted.keyVersion,
      },
      updatedAt: now,
    };

    if (!useMockStoreForTesting) {
      const db = this.getAdminFirestore();
      if (!db) {
        throw new Error('Firebase Admin Firestore not initialized');
      }
      try {
        await db.doc(docPath).set(docData, { merge: true });
      } catch (err: any) {
        throw new Error(`Failed to persist Angel One API key: ${err?.message || String(err)}`);
      }
      return;
    }

    inMemoryTestApiKeyStore.set(docPath, docData);
  }

  /**
   * Loads and decrypts the user's stored Angel One SmartAPI API key.
   */
  public static async loadApiKey(
    userId: string,
    connectionId = DEFAULT_CONNECTION_ID
  ): Promise<string | null> {
    if (!userId || !userId.trim()) {
      return null;
    }

    const trimmedUserId = userId.trim();
    const docPath = this.getApiKeyDocPath(trimmedUserId, connectionId);
    let docData: PersistedAngelOneApiKeyDoc | null = null;

    if (!useMockStoreForTesting) {
      const db = this.getAdminFirestore();
      if (!db) {
        return null;
      }
      try {
        const snap = await db.doc(docPath).get();
        if (snap.exists) {
          docData = snap.data() as PersistedAngelOneApiKeyDoc;
        }
      } catch {
        return null;
      }
    } else {
      docData = inMemoryTestApiKeyStore.get(docPath) || null;
    }

    if (!docData || !docData.encryptedApiKey) {
      return null;
    }

    try {
      const apiKey = CryptoService.decrypt(docData.encryptedApiKey, trimmedUserId);
      return apiKey;
    } catch {
      return null;
    }
  }

  /**
   * Deletes the user's stored Angel One API key credential.
   */
  public static async deleteApiKey(
    userId: string,
    connectionId = DEFAULT_CONNECTION_ID
  ): Promise<void> {
    if (!userId || !userId.trim()) {
      return;
    }

    const trimmedUserId = userId.trim();
    const docPath = this.getApiKeyDocPath(trimmedUserId, connectionId);

    if (!useMockStoreForTesting) {
      const db = this.getAdminFirestore();
      if (!db) {
        return;
      }
      try {
        await db.doc(docPath).delete();
      } catch {}
      return;
    }

    inMemoryTestApiKeyStore.delete(docPath);
  }
}
