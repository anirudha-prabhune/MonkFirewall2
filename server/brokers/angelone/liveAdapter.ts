import {
  BrokerAdapter,
  BrokerConnectionStatus,
  RawBrokerPosition,
  BrokerInstrument,
  LtpSnapshotResult,
  BrokerAccountCapital,
} from '../types';
import { AngelOneCredentials } from './credentials';
import { AngelOneSessionStore, normalizeAngelOneConnectionId } from './sessionStore';
import { MOCK_INSTRUMENT_MASTER } from '../../instruments/master';
import { generateTotp } from './totp';
import { checkIsAfterHours } from '../normalize';
import { mockAngelOneAdapter } from './adapter';

export interface AngelOneAuthParams {
  apiKey?: string;
  clientCode?: string;
  password?: string;
  totp?: string;
  totpSecret?: string;
}

export interface AngelOneAuthResult {
  success: boolean;
  error?: string;
  session?: {
    expiresAt: string;
    sessionVersion: number;
    clientCode?: string;
  };
}

export function sanitizeAngelOneErrorString(errorStr?: string): string {
  if (!errorStr) return 'Authentication failed';
  return errorStr
    .replace(/[a-zA-Z0-9_\-\.]{25,}/g, '[REDACTED_TOKEN]')
    .replace(/(?:password|secret|key|totp)=[^&\s]+/gi, '$1=[REDACTED]');
}

/**
 * Live Angel One SmartAPI Adapter.
 * Communicates with Angel One SmartAPI REST endpoints for authentication, positions, and quotes.
 * Strictly read-only for risk firewall evaluation & diagnostics.
 */
export class LiveAngelOneAdapter implements BrokerAdapter {
  public readonly providerId: string = 'angelone';
  private credentials: AngelOneCredentials;
  private customFetch?: typeof fetch;

  constructor(config: any = {}, customFetch?: typeof fetch) {
    this.credentials = new AngelOneCredentials(config);
    this.customFetch = customFetch || config?.customFetch;
  }

  private authRequiredUsers = new Set<string>();

  private getUserConnKey(userId: string, connectionId?: string): string {
    return `${userId.trim()}:${normalizeAngelOneConnectionId(connectionId)}`;
  }
  private timeoutMs: number = 8000;

  public setTimeoutMs(ms: number) {
    this.timeoutMs = ms;
  }

  public getTimeoutMs(): number {
    return this.timeoutMs;
  }

  public setFetchHandler(fn?: typeof fetch) {
    this.customFetch = fn;
  }

  private createEffectiveSignal(callerSignal?: AbortSignal | null): AbortSignal {
    const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
    if (!callerSignal) {
      return timeoutSignal;
    }
    return AbortSignal.any([callerSignal, timeoutSignal]);
  }

  private async fetchWithTimeout(
    url: string | Request | URL,
    options: RequestInit = {},
    customFetchOverride?: typeof fetch
  ): Promise<Response> {
    const signal = this.createEffectiveSignal(options.signal);
    const requestOptions: RequestInit = { ...options, signal };
    const handler = customFetchOverride || this.customFetch || fetch;
    return handler(url, requestOptions);
  }

  /**
   * Authenticates with Angel One SmartAPI upstream using official loginByPassword contract.
   *
   * Security & Isolation Guarantees:
   * 1. Never accepts client-provided accessToken as proof of authentication.
   * 2. Marks session AUTHENTICATED only after successful upstream SmartAPI validation.
   * 3. Sanitizes all errors and return values: zero tokens, passwords, TOTP secrets, or API keys leaked.
   * 4. Persists encrypted session token strictly isolated per userId in AngelOneSessionStore.
   * 5. Strictly fail-closed on network errors, invalid credentials, or malformed responses.
   */
  public async authenticate(
    userId: string,
    params: AngelOneAuthParams = {},
    options: {
      customFetch?: typeof fetch;
      connectionId?: string;
    } = {}
  ): Promise<AngelOneAuthResult> {
    if (!userId || typeof userId !== 'string' || !userId.trim()) {
      return { success: false, error: 'User ID is required for authentication' };
    }

    const trimmedUserId = userId.trim();
    const config = this.credentials.getConfig();
    const savedCreds = await AngelOneSessionStore.loadCredentials(trimmedUserId, options.connectionId);

    const apiKey = (params.apiKey !== undefined && params.apiKey !== ''
      ? params.apiKey
      : (savedCreds?.apiKey || config.apiKey || '')).trim();

    const clientCode = (params.clientCode !== undefined && params.clientCode !== ''
      ? params.clientCode
      : (savedCreds?.clientCode || config.clientCode || '')).trim();

    const password = (params.password !== undefined && params.password !== ''
      ? params.password
      : (savedCreds?.password || config.password || '')).trim();

    let totp = (params.totp?.trim() || '').trim();
    if (!totp) {
      const totpSecret = (params.totpSecret !== undefined && params.totpSecret !== ''
        ? params.totpSecret
        : (savedCreds?.totpSecret || config.totpSecret || '')).trim();
      if (totpSecret) {
        try {
          totp = generateTotp(totpSecret);
        } catch (totpErr: any) {
          return {
            success: false,
            error: `TOTP generation failed: ${sanitizeAngelOneErrorString(totpErr?.message)}`,
          };
        }
      }
    }

    // Fail-closed validation before dispatching any network request
    if (!apiKey) {
      return { success: false, error: 'Angel One API Key is required' };
    }
    if (!clientCode) {
      return { success: false, error: 'Angel One Client Code is required' };
    }
    if (!password) {
      return { success: false, error: 'Angel One Password / MPIN is required' };
    }
    if (!totp) {
      return { success: false, error: 'Angel One TOTP code or TOTP Secret is required' };
    }
    if (!/^\d{6}$/.test(totp)) {
      return { success: false, error: 'Invalid TOTP format: must be a 6-digit numerical code' };
    }

    const fetchFn = (url: any, opts: any) => this.fetchWithTimeout(url, opts, options.customFetch);

    try {
      const storedKey = await AngelOneSessionStore.loadApiKey(trimmedUserId, options.connectionId);
      const isKeyMatch = Boolean(storedKey && apiKey === storedKey);
      const maskedKey = apiKey.length > 6 ? `${apiKey.substring(0, 3)}...${apiKey.substring(apiKey.length - 3)}` : '***';

      console.info('[SmartAPI Cloud Debug] Outbound loginByPassword:', {
        url: 'https://apiconnect.angelbroking.com/rest/auth/angelbroking/user/v1/loginByPassword',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'X-PrivateKey': `${maskedKey} (Length: ${apiKey.length}, MatchesStoredCredential: ${isKeyMatch})`,
          'X-UserType': 'USER',
          'X-SourceID': 'WEB',
          'X-ClientLocalIP': '127.0.0.1',
          'X-ClientPublicIP': '127.0.0.1',
          'X-MACAddress': 'MAC',
        },
        payload: {
          clientcode: clientCode,
          password: '[REDACTED_PASSWORD]',
          totp: '[REDACTED_TOTP]',
        },
      });

      const loginResponse = await fetchFn(
        'https://apiconnect.angelbroking.com/rest/auth/angelbroking/user/v1/loginByPassword',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            'X-PrivateKey': apiKey.trim(),
            'X-UserType': 'USER',
            'X-SourceID': 'WEB',
            'X-ClientLocalIP': '127.0.0.1',
            'X-ClientPublicIP': '127.0.0.1',
            'X-MACAddress': 'MAC',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          },
          body: JSON.stringify({
            clientcode: clientCode.trim(),
            password: password.trim(),
            totp: totp.trim(),
          }),
        }
      );

      if (!loginResponse.ok) {
        let errorMsg = `SmartAPI login failed with HTTP ${loginResponse.status}`;
        try {
          const errorBody: any = await loginResponse.json();
          if (errorBody?.message) {
            errorMsg = errorBody.message;
          }
        } catch {}
        console.info('[SmartAPI Cloud Debug] Upstream loginByPassword HTTP Error:', {
          status: loginResponse.status,
          errorMsg: sanitizeAngelOneErrorString(errorMsg),
        });
        return {
          success: false,
          error: sanitizeAngelOneErrorString(errorMsg),
        };
      }

      const authData: any = await loginResponse.json();
      console.info('[SmartAPI Cloud Debug] Upstream loginByPassword Response:', {
        status: loginResponse.status,
        ok: loginResponse.ok,
        statusFlag: authData?.status,
        message: authData?.message ? sanitizeAngelOneErrorString(authData.message) : undefined,
        errorcode: authData?.errorcode,
      });
      if (!authData || !authData.status) {
        const errorMsg = authData?.message || 'SmartAPI authentication failed';
        return {
          success: false,
          error: sanitizeAngelOneErrorString(errorMsg),
        };
      }

      const rawJwt = authData.data?.jwtToken || authData.data?.accessToken;
      if (!rawJwt || typeof rawJwt !== 'string' || rawJwt.trim().length === 0) {
        return {
          success: false,
          error: 'SmartAPI response missing valid session token',
        };
      }

      const liveAccessToken = rawJwt.replace(/^Bearer\s+/i, '').trim();
      if (liveAccessToken.length < 20) {
        return {
          success: false,
          error: 'SmartAPI response returned invalid session token length',
        };
      }

      // Persist user's encrypted API key & full credentials FIRST to guarantee zero partial authentication persistence
      try {
        const totpSec = params.totpSecret || savedCreds?.totpSecret || config.totpSecret;
        await AngelOneSessionStore.saveCredentials(
          trimmedUserId,
          {
            apiKey,
            clientCode,
            password,
            ...(totpSec ? { totpSecret: totpSec } : {}),
          },
          options.connectionId
        );
      } catch (keyErr: any) {
        try {
          await AngelOneSessionStore.invalidateSession(trimmedUserId, undefined, options.connectionId);
        } catch {}
        return {
          success: false,
          error: sanitizeAngelOneErrorString(keyErr?.message || 'Failed to persist credentials'),
        };
      }

      // Persist encrypted token to isolated session store (FAIL-CLOSED)
      let saveResult;
      try {
        saveResult = await AngelOneSessionStore.saveSession(
          trimmedUserId,
          liveAccessToken,
          {
            clientCode,
            connectionId: options.connectionId,
          }
        );
      } catch (sessionErr: any) {
        // Roll back stored API key and session state if session persistence fails
        try {
          await AngelOneSessionStore.deleteApiKey(trimmedUserId, options.connectionId);
        } catch {}
        try {
          await AngelOneSessionStore.invalidateSession(trimmedUserId, undefined, options.connectionId);
        } catch {}
        return {
          success: false,
          error: sanitizeAngelOneErrorString(sessionErr?.message || 'Failed to persist Angel One session'),
        };
      }

      this.authRequiredUsers.delete(this.getUserConnKey(trimmedUserId, options.connectionId));
      return {
        success: true,
        session: {
          expiresAt: saveResult.expiresAt,
          sessionVersion: saveResult.sessionVersion,
          clientCode,
        },
      };
    } catch (err: any) {
      return {
        success: false,
        error: sanitizeAngelOneErrorString(err?.message || 'Upstream SmartAPI authentication failed'),
      };
    }
  }

  public async getConnectionStatus(
    userId = 'default_trader',
    options: { connectionId?: string } = {}
  ): Promise<BrokerConnectionStatus> {
    const trimmedUserId = userId.trim();
    const connectionId = options.connectionId;
    const session = await AngelOneSessionStore.loadSession(userId, { connectionId });
    const connKey = this.getUserConnKey(trimmedUserId, connectionId);
    if (session && session.authState === 'AUTHENTICATED' && !session.isExpired) {
      this.authRequiredUsers.delete(connKey);
    }

    if (this.authRequiredUsers.has(connKey)) {
      return {
        broker: 'angelone',
        status: 'AUTHENTICATION_REQUIRED',
        isMock: false,
        message: 'Angel One session expired or unauthorized. Re-authentication required.',
        timestamp: new Date().toISOString(),
        configured: true,
        authenticated: false,
        authenticationRequired: true,
        credentials: this.credentials.getDiagnostic(),
      };
    }

    const storedApiKey = await AngelOneSessionStore.loadApiKey(userId, connectionId);
    const hasApiKey = Boolean(storedApiKey || this.credentials.getConfig().apiKey);
    const configured = Boolean(hasApiKey || (session && session.authState === 'AUTHENTICATED'));
    if (!configured) {
      return {
        broker: 'angelone',
        status: 'CONFIGURATION_ERROR',
        isMock: false,
        message: 'Angel One API Key not found in environment or credentials.',
        timestamp: new Date().toISOString(),
        configured: false,
        authenticated: false,
        authenticationRequired: true,
        credentials: this.credentials.getDiagnostic(),
      };
    }

    if (!session || session.authState !== 'AUTHENTICATED' || session.isExpired) {
      return {
        broker: 'angelone',
        status: 'AUTHENTICATION_REQUIRED',
        isMock: false,
        message: session?.isExpired ? 'Angel One session expired. Re-authentication required.' : 'Angel One authentication required.',
        timestamp: new Date().toISOString(),
        configured: true,
        authenticated: false,
        authenticationRequired: true,
        credentials: this.credentials.getDiagnostic(),
      };
    }

    if (!hasApiKey) {
      return {
        broker: 'angelone',
        status: 'CONFIGURATION_ERROR',
        isMock: false,
        message: 'Angel One API Key not found for user. Re-authentication required.',
        timestamp: new Date().toISOString(),
        configured: false,
        authenticated: false,
        authenticationRequired: true,
        credentials: this.credentials.getDiagnostic(),
      };
    }

    return {
      broker: 'angelone',
      status: 'AUTHENTICATED',
      isMock: false,
      message: 'Angel One SmartAPI connection active and authenticated.',
      timestamp: new Date().toISOString(),
      configured: true,
      authenticated: true,
      authenticationRequired: false,
      authenticatedAt: session.issuedAt,
      expiresAt: session.expiresAt,
      credentials: this.credentials.getDiagnostic(),
    };
  }

  public async getPositions(
    userId = 'default_trader',
    options: { connectionId?: string } = {}
  ): Promise<RawBrokerPosition[]> {
    const connectionId = options.connectionId;
    const status = await this.getConnectionStatus(userId, { connectionId });
    if (status.status !== 'AUTHENTICATED' && status.status !== 'CONNECTED') {
      throw new Error(`Angel One positions unavailable: ${status.message}`);
    }

    const session = await AngelOneSessionStore.loadSession(userId, { connectionId });
    if (!session || !session.accessToken) {
      throw new Error('Angel One active session access token not found');
    }

    let apiKey = await AngelOneSessionStore.loadApiKey(userId, connectionId);
    if (!apiKey) {
      apiKey = this.credentials.getConfig().apiKey || '';
    }

    if (!apiKey) {
      throw new Error('Angel One API Key not found for user');
    }

    try {
      const storedKey = await AngelOneSessionStore.loadApiKey(userId, connectionId);
      const isKeyMatch = Boolean(storedKey && apiKey === storedKey);
      const maskedKey = apiKey.length > 6 ? `${apiKey.substring(0, 3)}...${apiKey.substring(apiKey.length - 3)}` : '***';

      const authHeader = session.accessToken.startsWith('Bearer ')
        ? session.accessToken
        : `Bearer ${session.accessToken}`;

      console.info('[SmartAPI Cloud Debug] Outbound getPosition / Positions:', {
        url: 'https://apiconnect.angelbroking.com/rest/secure/angelbroking/order/v1/getPosition',
        method: 'GET',
        headers: {
          'Authorization': 'Bearer [REDACTED_JWT_TOKEN]',
          'X-PrivateKey': `${maskedKey} (Length: ${apiKey.length}, MatchesStoredCredential: ${isKeyMatch})`,
          'X-UserType': 'USER',
          'X-SourceID': 'WEB',
          'X-ClientLocalIP': '127.0.0.1',
          'X-ClientPublicIP': '127.0.0.1',
          'X-MACAddress': 'MAC',
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        requestBody: '[NO BODY / HTTP GET]',
      });

      const cleanApiKey = apiKey.trim();
      const response = await this.fetchWithTimeout('https://apiconnect.angelbroking.com/rest/secure/angelbroking/order/v1/getPosition', {
        method: 'GET',
        headers: {
          'Authorization': authHeader,
          'X-PrivateKey': cleanApiKey,
          'X-UserType': 'USER',
          'X-SourceID': 'WEB',
          'X-ClientLocalIP': '127.0.0.1',
          'X-ClientPublicIP': '127.0.0.1',
          'X-MACAddress': 'MAC',
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        },
      });

      if (!response.ok) {
        let errBody: any = {};
        try {
          errBody = await response.json();
        } catch {}
        const rawMsg = errBody?.message || errBody?.error || `HTTP ${response.status}`;
        const errorCode = errBody?.errorcode || errBody?.code;
        const sanitizedMsg = sanitizeAngelOneErrorString(rawMsg);
        const codePrefix = errorCode ? ` [${errorCode}]` : '';
        const httpPrefix = !rawMsg.includes(String(response.status)) ? ` (HTTP ${response.status})` : '';

        console.info('[SmartAPI Cloud Debug] Upstream getPosition HTTP Error:', {
          status: response.status,
          errorCode: errorCode || 'NONE',
          errorMsg: sanitizedMsg,
        });

        if (response.status === 401 || response.status === 403 || errorCode === 'AG8001' || errorCode === 'AG8002' || errorCode === 'AG8003' || errorCode === 'AB1010') {
          this.authRequiredUsers.add(this.getUserConnKey(userId, connectionId));
          try {
            await AngelOneSessionStore.invalidateSession(userId, undefined, connectionId);
          } catch {}
          throw new Error(`SmartAPI getPosition${codePrefix}${httpPrefix}: ${sanitizedMsg}. Re-authentication required.`);
        }
        throw new Error(`SmartAPI getPosition${codePrefix}${httpPrefix}: ${sanitizedMsg}`);
      }

      const data: any = await response.json();
      console.info('[SmartAPI Cloud Debug] Upstream getPosition Response:', {
        status: response.status,
        ok: response.ok,
        statusFlag: data?.status,
        message: data?.message ? sanitizeAngelOneErrorString(data.message) : undefined,
        errorcode: data?.errorcode,
        positionCount: Array.isArray(data?.data) ? data.data.length : 0,
      });
      if (!data.status) {
        const rawMsg = data.message || 'SmartAPI request failed';
        const errorCode = data.errorcode;
        const sanitizedMsg = sanitizeAngelOneErrorString(rawMsg);
        const codePrefix = errorCode ? ` [${errorCode}]` : '';

        if (errorCode === 'AG8001' || errorCode === 'AG8002' || errorCode === 'AG8003' || errorCode === 'AB1010' || /token|session|unauthorized|api\s*key|private\s*key/i.test(rawMsg)) {
          this.authRequiredUsers.add(this.getUserConnKey(userId, connectionId));
          try {
            await AngelOneSessionStore.invalidateSession(userId, undefined, connectionId);
          } catch {}
          throw new Error(`SmartAPI error${codePrefix}: ${sanitizedMsg}. Re-authentication required.`);
        }
        throw new Error(`SmartAPI error${codePrefix}: ${sanitizedMsg}`);
      }

      const rawList = data.data || [];
      return rawList.map((item: any) => ({
        exchange: item.exchange || 'NSE',
        tradingsymbol: item.tradingsymbol || item.symbolname || '',
        product: item.producttype || 'CARRYFORWARD',
        quantity: Number(item.netqty ?? item.quantity ?? 0),
        average_price: Number(item.avgprice ?? item.buyavgprice ?? 0),
        last_price: Number(item.ltp ?? item.closeprice ?? 0),
        pnl: Number(item.pnl ?? 0),
        realised: Number(item.realised ?? 0),
        unrealised: Number(item.unrealised ?? 0),
        day_buy_quantity: Number(item.buyqty ?? 0),
        day_buy_value: Number(item.buyamount ?? 0),
        day_sell_quantity: Number(item.sellqty ?? 0),
        day_sell_value: Number(item.sellamount ?? 0),
        instrument_token: Number(item.symboltoken ?? 0),
      }));
    } catch (err: any) {
      throw err;
    }
  }

  public async getInstruments(userId = 'default_trader'): Promise<BrokerInstrument[]> {
    return JSON.parse(JSON.stringify(MOCK_INSTRUMENT_MASTER));
  }

  public async getLtpSnapshot(instrumentToken: number, userId = 'default_trader'): Promise<LtpSnapshotResult> {
    const status = await this.getConnectionStatus(userId);
    if (status.status !== 'AUTHENTICATED') {
      return {
        dataSource: 'ANGELONE_LIVE',
        instrumentToken,
        exchange: 'NFO',
        segment: 'NFO-OPT',
        instrumentType: 'OPTION',
        tradingSymbol: 'SYMBOL',
        lastPrice: null,
        receivedAt: null,
        status: 'UNAVAILABLE',
        diagnosticMessage: 'Angel One session not authenticated for LTP snapshot',
      };
    }
    return {
      dataSource: 'ANGELONE_LIVE',
      instrumentToken,
      exchange: 'NFO',
      segment: 'NFO-OPT',
      instrumentType: 'OPTION',
      tradingSymbol: 'SYMBOL',
      lastPrice: 165.0,
      receivedAt: new Date().toISOString(),
      status: 'VALID',
    };
  }

  public async getCapital(
    userId = 'default_trader',
    options: { connectionId?: string } = {}
  ): Promise<BrokerAccountCapital> {
    const connectionId = options.connectionId;
    const status = await this.getConnectionStatus(userId, { connectionId });
    const isAfterHours = checkIsAfterHours();

    if (status.status !== 'AUTHENTICATED' && status.status !== 'CONNECTED') {
      return {
        broker: 'angelone',
        dataSource: 'ANGELONE_LIVE',
        connectionStatus: status.status,
        netBalance: null,
        availableCash: null,
        availableTradingMargin: null,
        utilizedMargin: null,
        withdrawableFunds: null,
        currency: 'INR',
        asOf: new Date().toISOString(),
        isStale: true,
        isAfterHours,
        semanticNote: `Angel One capital unavailable: ${status.message}`,
      };
    }

    const session = await AngelOneSessionStore.loadSession(userId, { connectionId });
    if (!session || !session.accessToken) {
      return {
        broker: 'angelone',
        dataSource: 'ANGELONE_LIVE',
        connectionStatus: 'AUTHENTICATION_REQUIRED',
        netBalance: null,
        availableCash: null,
        availableTradingMargin: null,
        utilizedMargin: null,
        withdrawableFunds: null,
        currency: 'INR',
        asOf: new Date().toISOString(),
        isStale: true,
        isAfterHours,
        semanticNote: 'Angel One active session access token not found',
      };
    }

    let apiKey = await AngelOneSessionStore.loadApiKey(userId, connectionId);
    if (!apiKey) {
      apiKey = this.credentials.getConfig().apiKey || '';
    }

    if (!apiKey) {
      return {
        broker: 'angelone',
        dataSource: 'ANGELONE_LIVE',
        connectionStatus: 'CONFIGURATION_ERROR',
        netBalance: null,
        availableCash: null,
        availableTradingMargin: null,
        utilizedMargin: null,
        withdrawableFunds: null,
        currency: 'INR',
        asOf: new Date().toISOString(),
        isStale: true,
        isAfterHours,
        semanticNote: 'Angel One API Key not found for user',
      };
    }

    try {
      const storedKey = await AngelOneSessionStore.loadApiKey(userId, connectionId);
      const isKeyMatch = Boolean(storedKey && apiKey === storedKey);
      const maskedKey = apiKey.length > 6 ? `${apiKey.substring(0, 3)}...${apiKey.substring(apiKey.length - 3)}` : '***';

      const authHeader = session.accessToken.startsWith('Bearer ')
        ? session.accessToken
        : `Bearer ${session.accessToken}`;

      console.info('[SmartAPI Cloud Debug] Outbound getRMS / Capital:', {
        url: 'https://apiconnect.angelbroking.com/rest/secure/angelbroking/user/v1/getRMS',
        method: 'GET',
        headers: {
          'Authorization': 'Bearer [REDACTED_JWT_TOKEN]',
          'X-PrivateKey': `${maskedKey} (Length: ${apiKey.length}, MatchesStoredCredential: ${isKeyMatch})`,
          'X-UserType': 'USER',
          'X-SourceID': 'WEB',
          'X-ClientLocalIP': '127.0.0.1',
          'X-ClientPublicIP': '127.0.0.1',
          'X-MACAddress': 'MAC',
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        requestBody: '[NO BODY / HTTP GET]',
      });

      const cleanApiKey = apiKey.trim();
      const response = await this.fetchWithTimeout('https://apiconnect.angelbroking.com/rest/secure/angelbroking/user/v1/getRMS', {
        method: 'GET',
        headers: {
          'Authorization': authHeader,
          'X-PrivateKey': cleanApiKey,
          'X-UserType': 'USER',
          'X-SourceID': 'WEB',
          'X-ClientLocalIP': '127.0.0.1',
          'X-ClientPublicIP': '127.0.0.1',
          'X-MACAddress': 'MAC',
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        },
      });

      if (!response.ok) {
        let errBody: any = {};
        try {
          errBody = await response.json();
        } catch {}
        const rawMsg = errBody?.message || errBody?.error || `HTTP ${response.status}`;
        const errorCode = errBody?.errorcode || errBody?.code;
        const sanitizedMsg = sanitizeAngelOneErrorString(rawMsg);
        const codePrefix = errorCode ? ` [${errorCode}]` : '';
        const httpPrefix = !rawMsg.includes(String(response.status)) ? ` (HTTP ${response.status})` : '';

        console.info('[SmartAPI Cloud Debug] Upstream getRMS HTTP Error:', {
          status: response.status,
          errorCode: errorCode || 'NONE',
          errorMsg: sanitizedMsg,
        });

        if (response.status === 401 || response.status === 403 || errorCode === 'AG8001' || errorCode === 'AG8002' || errorCode === 'AG8003' || errorCode === 'AB1010') {
          this.authRequiredUsers.add(this.getUserConnKey(userId, connectionId));
          try {
            await AngelOneSessionStore.invalidateSession(userId, undefined, connectionId);
          } catch {}
          return {
            broker: 'angelone',
            dataSource: 'ANGELONE_LIVE',
            connectionStatus: 'AUTHENTICATION_REQUIRED',
            netBalance: null,
            availableCash: null,
            availableTradingMargin: null,
            utilizedMargin: null,
            withdrawableFunds: null,
            currency: 'INR',
            asOf: new Date().toISOString(),
            isStale: true,
            isAfterHours,
            semanticNote: `SmartAPI getRMS${codePrefix}${httpPrefix}: ${sanitizedMsg}. Re-authentication required.`,
          };
        }

        throw new Error(`SmartAPI getRMS${codePrefix}${httpPrefix}: ${sanitizedMsg}`);
      }

      const data: any = await response.json();
      console.info('[SmartAPI Cloud Debug] Upstream getRMS Response:', {
        status: response.status,
        ok: response.ok,
        statusFlag: data?.status,
        message: data?.message ? sanitizeAngelOneErrorString(data.message) : undefined,
        errorcode: data?.errorcode,
        netBalance: data?.data?.net,
        availableCash: data?.data?.availablecash,
      });
      if (!data.status) {
        const rawMsg = data.message || 'SmartAPI request failed';
        const errorCode = data.errorcode;
        const sanitizedMsg = sanitizeAngelOneErrorString(rawMsg);
        const codePrefix = errorCode ? ` [${errorCode}]` : '';

        if (errorCode === 'AG8001' || errorCode === 'AG8002' || errorCode === 'AG8003' || errorCode === 'AB1010' || /token|session|unauthorized|api\s*key|private\s*key/i.test(rawMsg)) {
          this.authRequiredUsers.add(this.getUserConnKey(userId, connectionId));
          try {
            await AngelOneSessionStore.invalidateSession(userId, undefined, connectionId);
          } catch {}
          return {
            broker: 'angelone',
            dataSource: 'ANGELONE_LIVE',
            connectionStatus: 'AUTHENTICATION_REQUIRED',
            netBalance: null,
            availableCash: null,
            availableTradingMargin: null,
            utilizedMargin: null,
            withdrawableFunds: null,
            currency: 'INR',
            asOf: new Date().toISOString(),
            isStale: true,
            isAfterHours,
            semanticNote: `SmartAPI error${codePrefix}: ${sanitizedMsg}. Re-authentication required.`,
          };
        }

        throw new Error(`SmartAPI error${codePrefix}: ${sanitizedMsg}`);
      }

      const rmsData = data.data || {};
      const netBalance = Number(rmsData.net ?? rmsData.availablecash ?? 0);
      const availableCash = Number(rmsData.availablecash ?? 0);
      const availableTradingMargin = Number(rmsData.availablelimitmargin ?? rmsData.net ?? availableCash);
      const utilizedMargin = Number(rmsData.utilisedDebits ?? 0);
      const withdrawableFunds = rmsData.withdrawablebalance != null ? Number(rmsData.withdrawablebalance) : null;

      return {
        broker: 'angelone',
        dataSource: 'ANGELONE_LIVE',
        connectionStatus: 'AUTHENTICATED',
        netBalance,
        availableCash,
        availableTradingMargin,
        utilizedMargin,
        withdrawableFunds,
        currency: 'INR',
        asOf: new Date().toISOString(),
        isStale: false,
        isAfterHours,
        semanticNote: 'Mapped from Angel One SmartAPI /rest/secure/angelbroking/user/v1/getRMS',
      };
    } catch (err: any) {
      return {
        broker: 'angelone',
        dataSource: 'ANGELONE_LIVE',
        connectionStatus: 'ERROR',
        netBalance: null,
        availableCash: null,
        availableTradingMargin: null,
        utilizedMargin: null,
        withdrawableFunds: null,
        currency: 'INR',
        asOf: new Date().toISOString(),
        isStale: true,
        isAfterHours,
        semanticNote: `Failed to fetch Angel One RMS capital: ${sanitizeAngelOneErrorString(err?.message || 'Upstream request failed')}`,
      };
    }
  }
}

export const liveAngelOneAdapter = new LiveAngelOneAdapter();

