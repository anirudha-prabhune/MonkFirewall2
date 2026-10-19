import { EncryptedPayload, CryptoService } from '../../security/crypto';
import { getAdminFirestore } from '../zerodha/sessionStore';
import { DEFAULT_ANGELONE_ACCOUNT_ID } from '../../../src/types/risk';

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

export interface PersistedAngelOneCredentialsDoc {
  provider: 'angelone';
  userId: string;
  connectionId: string;
  encryptedApiKey: EncryptedPayload;
  encryptedClientCode: EncryptedPayload;
  encryptedPassword: EncryptedPayload;
  encryptedTotpSecret?: EncryptedPayload;
  updatedAt: string;
}

const DEFAULT_CONNECTION_ID = DEFAULT_ANGELONE_ACCOUNT_ID; // 'acc_mt_angelone_default'
let useMockStoreForTesting = false;
export const inMemoryTestStore = new Map<string, PersistedAngelOneSessionDoc>();
export const inMemoryTestApiKeyStore = new Map<string, PersistedAngelOneApiKeyDoc>();
export const inMemoryTestCredentialsStore = new Map<string, PersistedAngelOneCredentialsDoc>();

export function normalizeAngelOneConnectionId(connectionId?: string): string {
  if (
    !connectionId ||
    !connectionId.trim() ||
    connectionId.trim() === 'angelone_default' ||
    connectionId.trim() === DEFAULT_ANGELONE_ACCOUNT_ID
  ) {
    return DEFAULT_ANGELONE_ACCOUNT_ID;
  }
  return connectionId.trim();
}

export class AngelOneSessionStore {
  private static invalidatedUsers = new Set<string>();

  private static getUserConnKey(userId: string, connectionId?: string): string {
    return `${userId.trim()}:${normalizeAngelOneConnectionId(connectionId)}`;
  }

  public static enableMockStoreForTesting(enabled: boolean): void {
    useMockStoreForTesting = enabled;
    if (!enabled) {
      inMemoryTestStore.clear();
      inMemoryTestApiKeyStore.clear();
      inMemoryTestCredentialsStore.clear();
      this.invalidatedUsers.clear();
    }
  }

  public static getSessionDocPath(userId: string, connectionId = DEFAULT_CONNECTION_ID): string {
    const connId = normalizeAngelOneConnectionId(connectionId);
    return `users/${userId.trim()}/brokerConnections/${connId}/runtimeSession/current`;
  }

  public static getApiKeyDocPath(userId: string, connectionId = DEFAULT_CONNECTION_ID): string {
    const connId = normalizeAngelOneConnectionId(connectionId);
    return `users/${userId.trim()}/brokerConnections/${connId}/credentials/apiKey`;
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

    const connId = normalizeAngelOneConnectionId(options.connectionId);
    const now = new Date();
    const validityHours = options.validityHours || 24;
    const expiryUtc = new Date(now.getTime() + validityHours * 3600 * 1000);

    this.invalidatedUsers.delete(this.getUserConnKey(userId, connId));
    const encrypted = CryptoService.encrypt(accessToken, userId.trim(), 'angelone', connId);
    const docPath = this.getSessionDocPath(userId, connId);

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
    const trimmedUserId = userId.trim();
    const connId = normalizeAngelOneConnectionId(options.connectionId);
    const now = options.evaluationTime || new Date();
    if (this.invalidatedUsers.has(this.getUserConnKey(userId, connId))) {
      return {
        accessToken: '',
        sessionVersion: 0,
        issuedAt: now.toISOString(),
        expiresAt: now.toISOString(),
        authState: 'AUTHENTICATION_REQUIRED',
        isExpired: true,
      };
    }
    const docPath = this.getSessionDocPath(userId, connId);
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
      await this.invalidateSession(userId, docData.sessionVersion, connId);
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
      let accessToken: string;
      try {
        accessToken = CryptoService.decrypt(docData.encryptedToken, trimmedUserId, 'angelone', connId);
      } catch {
        try {
          accessToken = CryptoService.decrypt(docData.encryptedToken, trimmedUserId, 'zerodha', connId);
        } catch {
          accessToken = CryptoService.decrypt(docData.encryptedToken, trimmedUserId, 'zerodha');
        }
      }
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
      await this.invalidateSession(userId, docData.sessionVersion, connId);
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
    const connId = normalizeAngelOneConnectionId(connectionId);
    this.invalidatedUsers.add(this.getUserConnKey(userId, connId));
    const docPath = this.getSessionDocPath(userId, connId);
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
    const connId = normalizeAngelOneConnectionId(connectionId);
    const now = new Date().toISOString();
    const encrypted = CryptoService.encrypt(trimmedApiKey, trimmedUserId, 'angelone', connId);
    const docPath = this.getApiKeyDocPath(trimmedUserId, connId);

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
    const connId = normalizeAngelOneConnectionId(connectionId);
    const docPath = this.getApiKeyDocPath(trimmedUserId, connId);
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
      const fullCreds = await this.loadCredentials(userId, connId);
      return fullCreds ? fullCreds.apiKey : null;
    }

    try {
      let apiKey: string;
      try {
        apiKey = CryptoService.decrypt(docData.encryptedApiKey, trimmedUserId, 'angelone', connId);
      } catch {
        try {
          apiKey = CryptoService.decrypt(docData.encryptedApiKey, trimmedUserId, 'zerodha', connId);
        } catch {
          apiKey = CryptoService.decrypt(docData.encryptedApiKey, trimmedUserId, 'zerodha');
        }
      }
      return apiKey;
    } catch {
      const fullCreds = await this.loadCredentials(userId, connId);
      return fullCreds ? fullCreds.apiKey : null;
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
    const connId = normalizeAngelOneConnectionId(connectionId);
    const docPath = this.getApiKeyDocPath(trimmedUserId, connId);

    if (!useMockStoreForTesting) {
      const db = this.getAdminFirestore();
      if (!db) {
        return;
      }
      try {
        await db.doc(docPath).delete();
      } catch {}
    } else {
      inMemoryTestApiKeyStore.delete(docPath);
    }

    await this.deleteCredentials(userId, connId);
  }

  /**
   * Helper to construct Angel One credentials document path:
   * users/{userId}/brokerConnections/{connectionId}/credentials/angelone
   */
  public static getCredentialsDocPath(userId: string, connectionId = DEFAULT_CONNECTION_ID): string {
    const connId = normalizeAngelOneConnectionId(connectionId);
    return `users/${userId.trim()}/brokerConnections/${connId}/credentials/angelone`;
  }

  /**
   * Encrypts and persists Angel One credentials (apiKey, clientCode, password, totpSecret) per user and connection.
   */
  public static async saveCredentials(
    userId: string,
    credentials: { apiKey: string; clientCode: string; password: string; totpSecret?: string },
    connectionId = DEFAULT_CONNECTION_ID
  ): Promise<void> {
    if (!userId || !userId.trim()) {
      throw new Error('UserId is required to save Angel One credentials');
    }
    if (!credentials.apiKey || !credentials.apiKey.trim()) {
      throw new Error('API Key is required to save Angel One credentials');
    }
    if (!credentials.clientCode || !credentials.clientCode.trim()) {
      throw new Error('Client Code is required to save Angel One credentials');
    }
    if (!credentials.password || !credentials.password.trim()) {
      throw new Error('Password is required to save Angel One credentials');
    }

    const trimmedUserId = userId.trim();
    const connId = normalizeAngelOneConnectionId(connectionId);
    const now = new Date().toISOString();

    const encryptedKey = CryptoService.encrypt(credentials.apiKey.trim(), trimmedUserId, 'angelone', connId);
    const encryptedCode = CryptoService.encrypt(credentials.clientCode.trim(), trimmedUserId, 'angelone', connId);
    const encryptedPass = CryptoService.encrypt(credentials.password.trim(), trimmedUserId, 'angelone', connId);
    const encryptedTotp = credentials.totpSecret && credentials.totpSecret.trim()
      ? CryptoService.encrypt(credentials.totpSecret.trim(), trimmedUserId, 'angelone', connId)
      : undefined;

    const docPath = this.getCredentialsDocPath(trimmedUserId, connId);
    const docData: PersistedAngelOneCredentialsDoc = {
      provider: 'angelone',
      userId: trimmedUserId,
      connectionId: connId,
      encryptedApiKey: {
        iv: encryptedKey.iv,
        ciphertext: encryptedKey.ciphertext,
        tag: encryptedKey.tag,
        keyVersion: encryptedKey.keyVersion,
      },
      encryptedClientCode: {
        iv: encryptedCode.iv,
        ciphertext: encryptedCode.ciphertext,
        tag: encryptedCode.tag,
        keyVersion: encryptedCode.keyVersion,
      },
      encryptedPassword: {
        iv: encryptedPass.iv,
        ciphertext: encryptedPass.ciphertext,
        tag: encryptedPass.tag,
        keyVersion: encryptedPass.keyVersion,
      },
      ...(encryptedTotp ? {
        encryptedTotpSecret: {
          iv: encryptedTotp.iv,
          ciphertext: encryptedTotp.ciphertext,
          tag: encryptedTotp.tag,
          keyVersion: encryptedTotp.keyVersion,
        }
      } : {}),
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
        throw new Error(`Failed to save Angel One credentials: ${err?.message || String(err)}`);
      }
    } else {
      inMemoryTestCredentialsStore.set(docPath, docData);
    }

    // Also synchronize saveApiKey
    await this.saveApiKey(trimmedUserId, credentials.apiKey.trim(), connId);
  }

  /**
   * Loads and decrypts stored Angel One credentials for a given user and connection.
   */
  public static async loadCredentials(
    userId: string,
    connectionId = DEFAULT_CONNECTION_ID
  ): Promise<{ apiKey: string; clientCode: string; password: string; totpSecret?: string } | null> {
    if (!userId || !userId.trim()) {
      return null;
    }

    const trimmedUserId = userId.trim();
    const connId = normalizeAngelOneConnectionId(connectionId);
    const docPath = this.getCredentialsDocPath(trimmedUserId, connId);

    let docData: PersistedAngelOneCredentialsDoc | null = null;

    if (!useMockStoreForTesting) {
      const db = this.getAdminFirestore();
      if (!db) {
        return null;
      }
      try {
        const snap = await db.doc(docPath).get();
        if (snap.exists) {
          docData = snap.data() as PersistedAngelOneCredentialsDoc;
        }
      } catch {
        return null;
      }
    } else {
      docData = inMemoryTestCredentialsStore.get(docPath) || null;
    }

    if (!docData || !docData.encryptedApiKey || !docData.encryptedClientCode || !docData.encryptedPassword) {
      return null;
    }

    try {
      const decryptField = (payload: EncryptedPayload): string => {
        try {
          return CryptoService.decrypt(payload, trimmedUserId, 'angelone', connId);
        } catch {
          try {
            return CryptoService.decrypt(payload, trimmedUserId, 'zerodha', connId);
          } catch {
            return CryptoService.decrypt(payload, trimmedUserId, 'zerodha');
          }
        }
      };

      const apiKey = decryptField(docData.encryptedApiKey);
      const clientCode = decryptField(docData.encryptedClientCode);
      const password = decryptField(docData.encryptedPassword);
      const totpSecret = docData.encryptedTotpSecret
        ? decryptField(docData.encryptedTotpSecret)
        : undefined;

      return { apiKey, clientCode, password, totpSecret };
    } catch {
      return null;
    }
  }

  /**
   * Deletes stored Angel One credentials and invalidates active session for user and connection.
   */
  public static async deleteCredentials(
    userId: string,
    connectionId = DEFAULT_CONNECTION_ID
  ): Promise<void> {
    if (!userId || !userId.trim()) {
      return;
    }

    const trimmedUserId = userId.trim();
    const connId = normalizeAngelOneConnectionId(connectionId);
    const docPath = this.getCredentialsDocPath(trimmedUserId, connId);

    if (!useMockStoreForTesting) {
      const db = this.getAdminFirestore();
      if (db) {
        try {
          await db.doc(docPath).delete();
        } catch {}
      }
    } else {
      inMemoryTestCredentialsStore.delete(docPath);
    }

    await this.invalidateSession(trimmedUserId, undefined, connId);
  }
}
