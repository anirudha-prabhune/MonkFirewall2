import {
  BrokerAdapter,
  BrokerConnectionStatus,
  RawBrokerPosition,
  BrokerInstrument,
  LtpSnapshotResult,
  BrokerAccountCapital,
} from '../types';
import { ZerodhaCredentialManager } from './credentials';
import { classifyInstrument } from '../../instruments/master';
import { checkIsAfterHours } from '../normalize';

export class InstrumentValidationError extends Error {
  constructor(message: string) {
    super(`[InstrumentValidationError] ${message}`);
    this.name = 'InstrumentValidationError';
  }
}

export type HttpFetchFn = (url: string, options?: any) => Promise<{
  ok: boolean;
  status: number;
  statusText?: string;
  headers?: any;
  json: () => Promise<any>;
  text?: () => Promise<string>;
}>;

/**
 * Phase 7 & 8A — Live Zerodha Read-Only Broker Adapter with Authoritative Session Persistence.
 *
 * CRITICAL ARCHITECTURAL CONSTRAINTS:
 * 1. READ-ONLY CONTRACT: Contains ZERO order, trading, square-off, or execution methods.
 * 2. SERVER-ONLY SECRETS: Never exposes api_key, api_secret, or access_token to responses, logs, or errors.
 * 3. AUTHORITATIVE SESSION (PHASE 8A): All calls resolve the active session via ZerodhaCredentialManager.
 * 4. TOKENEXCEPTION CONCURRENCY SAFETY: 401/403 invalidates only the failed sessionVersion without destroying newer sessions.
 */
export class LiveZerodhaAdapter implements BrokerAdapter {
  public readonly providerId: string = 'zerodha';
  private customFetch?: HttpFetchFn;
  private timeoutMs: number = 8000;
  private cachedInstruments: BrokerInstrument[] | null = null;
  private instrumentCacheTimestamp: number = 0;
  private readonly INSTRUMENT_CACHE_TTL_MS = 3600 * 1000; // 1 hour

  constructor(customFetch?: HttpFetchFn) {
    this.customFetch = customFetch;
  }

  public setTimeoutMs(ms: number) {
    this.timeoutMs = ms;
  }

  public getTimeoutMs(): number {
    return this.timeoutMs;
  }

  /**
   * Allows injecting a custom HTTP fetch handler (primarily for unit/integration testing).
   */
  public setFetchHandler(fn?: HttpFetchFn) {
    this.customFetch = fn;
    this.cachedInstruments = null;
  }

  private createEffectiveSignal(callerSignal?: AbortSignal): AbortSignal {
    const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
    if (!callerSignal) {
      return timeoutSignal;
    }
    return AbortSignal.any([callerSignal, timeoutSignal]);
  }

  private async fetch(url: string, options: any = {}) {
    const signal = this.createEffectiveSignal(options.signal);
    const requestOptions = { ...options, signal };
    if (this.customFetch) {
      return this.customFetch(url, requestOptions);
    }
    return fetch(url, requestOptions);
  }

  /**
   * Retrieves live connection status using server-side credentials and persisted daily session.
   */
  public async getConnectionStatus(
    userId = 'default_trader',
    options: { connectionId?: string } = {}
  ): Promise<BrokerConnectionStatus> {
    const connectionId = options.connectionId || 'zerodha';
    const presence = ZerodhaCredentialManager.getPresenceDiagnostic(userId);
    const { apiKey } = await ZerodhaCredentialManager.getCredentialsForUser(userId, connectionId);

    if (!apiKey || apiKey.trim().length === 0) {
      return {
        broker: 'zerodha',
        status: 'CONFIGURATION_ERROR',
        isMock: false,
        configured: false,
        authenticated: false,
        authenticationRequired: true,
        credentials: presence,
        message: 'Missing required Zerodha credentials: ZERODHA_API_KEY',
        timestamp: new Date().toISOString(),
      };
    }

    const authSession = await ZerodhaCredentialManager.getAuthenticatedSession(userId, connectionId);
    if (!authSession) {
      const persistentCheck = await ZerodhaCredentialManager.validatePersistentConfigForUser(userId, connectionId);
      if (!persistentCheck.configured) {
        return {
          broker: 'zerodha',
          status: 'CONFIGURATION_ERROR',
          isMock: false,
          configured: false,
          authenticated: false,
          authenticationRequired: true,
          credentials: presence,
          message: persistentCheck.error || 'Missing required Zerodha credentials: ZERODHA_API_SECRET',
          timestamp: new Date().toISOString(),
        };
      }
      return {
        broker: 'zerodha',
        status: 'AUTHENTICATION_REQUIRED',
        isMock: false,
        configured: true,
        authenticated: false,
        authenticationRequired: true,
        credentials: presence,
        message: 'Zerodha authentication required. Please authenticate via Kite Connect login.',
        timestamp: new Date().toISOString(),
      };
    }

    try {
      const response = await this.fetch('https://api.kite.trade/user/profile', {
        method: 'GET',
        headers: {
          'X-Kite-Version': '3',
          Authorization: `token ${apiKey}:${authSession.accessToken}`,
        },
      });

      if (response.status === 401 || response.status === 403) {
        await ZerodhaCredentialManager.handleTokenException(userId, authSession.sessionVersion, connectionId);
        return {
          broker: 'zerodha',
          status: 'AUTHENTICATION_ERROR',
          isMock: false,
          configured: true,
          authenticated: false,
          authenticationRequired: true,
          credentials: ZerodhaCredentialManager.getPresenceDiagnostic(userId),
          message: 'Authentication failed: Invalid or expired Zerodha access token. Please re-authenticate.',
          timestamp: new Date().toISOString(),
        };
      }

      if (!response.ok) {
        return {
          broker: 'zerodha',
          status: 'UPSTREAM_ERROR',
          isMock: false,
          configured: true,
          authenticated: false,
          authenticationRequired: false,
          credentials: presence,
          message: `Zerodha profile endpoint returned HTTP ${response.status}`,
          timestamp: new Date().toISOString(),
        };
      }

      const body = await response.json();
      if (body.status === 'success') {
        ZerodhaCredentialManager.setAuthState('AUTHENTICATED');
        return {
          broker: 'zerodha',
          status: 'CONNECTED',
          isMock: false,
          configured: true,
          authenticated: true,
          authenticationRequired: false,
          authenticatedAt: new Date().toISOString(),
          expiresAt: authSession.expiresAt,
          credentials: ZerodhaCredentialManager.getPresenceDiagnostic(userId),
          message: 'Connected and authenticated with Live Zerodha Kite Connect API (Read-Only).',
          timestamp: new Date().toISOString(),
        };
      }

      await ZerodhaCredentialManager.handleTokenException(userId, authSession.sessionVersion, connectionId);
      return {
        broker: 'zerodha',
        status: 'AUTHENTICATION_ERROR',
        isMock: false,
        configured: true,
        authenticated: false,
        authenticationRequired: true,
        credentials: ZerodhaCredentialManager.getPresenceDiagnostic(userId),
        message: ZerodhaCredentialManager.sanitizeErrorString(body.message || 'Zerodha session validation failed.'),
        timestamp: new Date().toISOString(),
      };
    } catch (err) {
      const rawMsg = err instanceof Error ? err.message : 'Unknown error';
      return {
        broker: 'zerodha',
        status: 'UPSTREAM_ERROR',
        isMock: false,
        configured: true,
        authenticated: false,
        authenticationRequired: false,
        credentials: presence,
        message: ZerodhaCredentialManager.sanitizeErrorString(`Network failure connecting to Zerodha API: ${rawMsg}`),
        timestamp: new Date().toISOString(),
      };
    }
  }

  /**
   * Retrieves current positions via Kite Connect /portfolio/positions (READ-ONLY).
   */
  public async getPositions(
    userId = 'default_trader',
    options: { connectionId?: string } = {}
  ): Promise<RawBrokerPosition[]> {
    const connectionId = options.connectionId || 'zerodha';
    const credCheck = await ZerodhaCredentialManager.validatePersistentConfigForUser(userId, connectionId);
    if (!credCheck.configured) {
      throw new Error(`[LiveZerodhaAdapter] Cannot fetch positions: ${credCheck.error}`);
    }

    const authSession = await ZerodhaCredentialManager.getAuthenticatedSession(userId, connectionId);
    if (!authSession) {
      throw new Error('[LiveZerodhaAdapter] Authentication failure: No active Zerodha access token. Please authenticate via Kite Connect.');
    }

    const { apiKey } = await ZerodhaCredentialManager.getCredentialsForUser(userId, connectionId);

    try {
      const response = await this.fetch('https://api.kite.trade/portfolio/positions', {
        method: 'GET',
        headers: {
          'X-Kite-Version': '3',
          Authorization: `token ${apiKey}:${authSession.accessToken}`,
        },
      });

      if (response.status === 401 || response.status === 403) {
        await ZerodhaCredentialManager.handleTokenException(userId, authSession.sessionVersion);
        throw new Error('[LiveZerodhaAdapter] Authentication failure: Invalid or expired access token (TokenException). Please re-authenticate.');
      }

      if (!response.ok) {
        throw new Error(`[LiveZerodhaAdapter] Upstream positions API returned HTTP ${response.status}`);
      }

      const body = await response.json();
      if (body.status !== 'success' || !body.data) {
        throw new Error(`[LiveZerodhaAdapter] Malformed positions response: ${body.message || 'Missing data'}`);
      }

      const netPositions: RawBrokerPosition[] = (body.data.net || []).map((p: any) => ({
        ...p,
        provenance: 'net' as const,
      }));
      const dayPositions: RawBrokerPosition[] = (body.data.day || []).map((p: any) => ({
        ...p,
        provenance: 'day' as const,
      }));

      return [...netPositions, ...dayPositions];
    } catch (err) {
      if (err instanceof Error) throw err;
      throw new Error('[LiveZerodhaAdapter] Failed to fetch live positions from Zerodha');
    }
  }

  /**
   * Validates a single instrument record from Zerodha.
   */
  public validateInstrumentRecord(raw: any): BrokerInstrument {
    if (!raw || typeof raw !== 'object') {
      throw new InstrumentValidationError('Instrument record must be a non-null object');
    }

    const token = raw.instrument_token ?? raw.instrumentToken;
    if (typeof token !== 'number' || !Number.isInteger(token) || token <= 0) {
      throw new InstrumentValidationError(`Invalid instrument_token: ${token}`);
    }

    const exchange = raw.exchange;
    if (typeof exchange !== 'string' || exchange.trim().length === 0) {
      throw new InstrumentValidationError(`Invalid exchange for token ${token}: ${exchange}`);
    }

    const tradingsymbol = raw.tradingsymbol;
    if (typeof tradingsymbol !== 'string' || tradingsymbol.trim().length === 0) {
      throw new InstrumentValidationError(`Invalid tradingsymbol for token ${token}: ${tradingsymbol}`);
    }

    const segment = raw.segment;
    if (typeof segment !== 'string' || segment.trim().length === 0) {
      throw new InstrumentValidationError(`Invalid segment for token ${token}: ${segment}`);
    }

    const instrumentType = raw.instrument_type ?? raw.instrumentType ?? 'UNKNOWN';

    classifyInstrument({ segment, instrumentType });

    return {
      instrumentToken: token,
      exchange: exchange.trim().toUpperCase(),
      tradingsymbol: tradingsymbol.trim(),
      name: (raw.name || tradingsymbol).trim(),
      segment: segment.trim().toUpperCase(),
      instrumentType: String(instrumentType).trim().toUpperCase(),
      expiry: raw.expiry ? String(raw.expiry).trim() : null,
      strike: typeof raw.strike === 'number' && Number.isFinite(raw.strike) ? raw.strike : null,
      tickSize: typeof raw.tick_size === 'number' ? raw.tick_size : typeof raw.tickSize === 'number' ? raw.tickSize : 0.05,
      lotSize: typeof raw.lot_size === 'number' ? raw.lot_size : typeof raw.lotSize === 'number' ? raw.lotSize : 1,
    };
  }

  /**
   * Retrieves and validates live instrument master records.
   */
  public async getInstruments(
    userId = 'default_trader',
    options: { connectionId?: string } = {}
  ): Promise<BrokerInstrument[]> {
    const connectionId = options.connectionId || 'zerodha';
    const now = Date.now();
    if (this.cachedInstruments && now - this.instrumentCacheTimestamp < this.INSTRUMENT_CACHE_TTL_MS) {
      return this.cachedInstruments;
    }

    const credCheck = await ZerodhaCredentialManager.validatePersistentConfigForUser(userId, connectionId);
    if (!credCheck.configured) {
      throw new Error(`[LiveZerodhaAdapter] Cannot fetch instruments: ${credCheck.error}`);
    }

    const authSession = await ZerodhaCredentialManager.getAuthenticatedSession(userId, connectionId);
    if (!authSession) {
      throw new Error('[LiveZerodhaAdapter] Authentication failure: No active Zerodha access token. Please authenticate via Kite Connect.');
    }

    const { apiKey } = await ZerodhaCredentialManager.getCredentialsForUser(userId, connectionId);

    try {
      const response = await this.fetch('https://api.kite.trade/instruments', {
        method: 'GET',
        headers: {
          'X-Kite-Version': '3',
          Authorization: `token ${apiKey}:${authSession.accessToken}`,
        },
      });

      if (response.status === 401 || response.status === 403) {
        await ZerodhaCredentialManager.handleTokenException(userId, authSession.sessionVersion, connectionId);
        throw new Error('[LiveZerodhaAdapter] Authentication failure: Invalid or expired access token. Please re-authenticate.');
      }

      if (!response.ok) {
        throw new Error(`[LiveZerodhaAdapter] Upstream instruments API returned HTTP ${response.status}`);
      }

      let rawRecords: any[] = [];
      const contentType = response.headers?.get ? response.headers.get('content-type') : '';
      if (contentType && contentType.includes('application/json')) {
        const body = await response.json();
        rawRecords = Array.isArray(body) ? body : body.data || [];
      } else {
        const text = response.text ? await response.text() : await (response as any).json();
        if (typeof text === 'string') {
          rawRecords = this.parseInstrumentsCsv(text);
        } else if (Array.isArray(text)) {
          rawRecords = text;
        } else if (text && Array.isArray(text.data)) {
          rawRecords = text.data;
        }
      }

      const validated: BrokerInstrument[] = [];
      for (const rec of rawRecords) {
        try {
          validated.push(this.validateInstrumentRecord(rec));
        } catch (err) {
          if (err instanceof InstrumentValidationError) {
            console.warn(`[LiveZerodhaAdapter] Skipping malformed instrument: ${err.message}`);
          }
        }
      }

      if (validated.length > 0) {
        this.cachedInstruments = validated;
        this.instrumentCacheTimestamp = now;
      }
      return validated;
    } catch (err) {
      if (err instanceof Error) throw err;
      throw new Error('[LiveZerodhaAdapter] Failed to fetch instruments from Zerodha');
    }
  }

  /**
   * Simple CSV parser for Zerodha instruments CSV dump.
   */
  private parseInstrumentsCsv(csv: string): any[] {
    const lines = csv.trim().split('\n');
    if (lines.length < 2) return [];

    const headers = lines[0].split(',').map((h) => h.trim().replace(/^"|"$/g, ''));
    const records: any[] = [];

    for (let i = 1; i < lines.length; i++) {
      const row = lines[i].split(',').map((cell) => cell.trim().replace(/^"|"$/g, ''));
      if (row.length !== headers.length) continue;

      const obj: any = {};
      headers.forEach((h, idx) => {
        obj[h] = row[idx];
      });

      if (obj.instrument_token) obj.instrument_token = parseInt(obj.instrument_token, 10);
      if (obj.strike) obj.strike = parseFloat(obj.strike);
      if (obj.tick_size) obj.tick_size = parseFloat(obj.tick_size);
      if (obj.lot_size) obj.lot_size = parseInt(obj.lot_size, 10);

      records.push(obj);
    }

    return records;
  }

  /**
   * Retrieves instantaneous read-only LTP snapshot for a single F&O instrument (Phase 8A).
   * Strictly read-only: No orders, no risk mutation, no credentials exposed.
   */
  public async getLtpSnapshot(
    instrumentToken: number,
    userId = 'default_trader',
    options: { connectionId?: string } = {}
  ): Promise<LtpSnapshotResult> {
    const connectionId = options.connectionId || 'zerodha';
    const instruments = await this.getInstruments(userId, { connectionId });
    const instrument = instruments.find((i) => i.instrumentToken === instrumentToken);

    if (!instrument) {
      throw new Error(`[LiveZerodhaAdapter] Unknown instrument token: ${instrumentToken}`);
    }

    const classification = classifyInstrument(instrument);
    if (!classification.isFno) {
      throw new Error(`[LiveZerodhaAdapter] Non-F&O instrument rejected: ${instrument.tradingsymbol} (${instrument.segment})`);
    }

    const credCheck = await ZerodhaCredentialManager.validatePersistentConfigForUser(userId, connectionId);
    if (!credCheck.configured) {
      throw new Error(`[LiveZerodhaAdapter] Cannot fetch LTP snapshot: ${credCheck.error}`);
    }

    const authSession = await ZerodhaCredentialManager.getAuthenticatedSession(userId, connectionId);
    if (!authSession) {
      throw new Error('[LiveZerodhaAdapter] Authentication failure: Missing or expired Zerodha session token.');
    }

    const { apiKey } = await ZerodhaCredentialManager.getCredentialsForUser(userId, connectionId);
    const queryParam = `${instrument.exchange}:${instrument.tradingsymbol}`;

    try {
      const url = `https://api.kite.trade/quote/ltp?i=${encodeURIComponent(queryParam)}`;
      const response = await this.fetch(url, {
        method: 'GET',
        headers: {
          'X-Kite-Version': '3',
          Authorization: `token ${apiKey}:${authSession.accessToken}`,
        },
      });

      if (response.status === 401 || response.status === 403) {
        await ZerodhaCredentialManager.handleTokenException(userId, authSession.sessionVersion, connectionId);
        throw new Error('[LiveZerodhaAdapter] Authentication failure: Invalid or expired access token (HTTP 403 TokenException).');
      }

      if (!response.ok) {
        throw new Error(`[LiveZerodhaAdapter] Upstream quote/ltp returned HTTP ${response.status}`);
      }

      const body = await response.json();
      if (body.status !== 'success' || !body.data) {
        return {
          dataSource: 'ZERODHA_LIVE',
          instrumentToken,
          exchange: instrument.exchange,
          segment: instrument.segment,
          instrumentType: instrument.instrumentType,
          tradingSymbol: instrument.tradingsymbol,
          lastPrice: null,
          receivedAt: new Date().toISOString(),
          status: 'UNAVAILABLE',
          diagnosticMessage: ZerodhaCredentialManager.sanitizeErrorString(body?.message || 'No quote data returned'),
        };
      }

      const quoteData =
        body.data[queryParam] ||
        body.data[String(instrumentToken)] ||
        Object.values(body.data).find(
          (v: any) => (v?.instrument_token ?? v?.instrumentToken) === instrumentToken
        );
      const ltp = quoteData?.last_price ?? quoteData?.lastPrice;

      if (typeof ltp === 'number' && Number.isFinite(ltp) && ltp >= 0) {
        return {
          dataSource: 'ZERODHA_LIVE',
          instrumentToken,
          exchange: instrument.exchange,
          segment: instrument.segment,
          instrumentType: instrument.instrumentType,
          tradingSymbol: instrument.tradingsymbol,
          lastPrice: ltp,
          receivedAt: new Date().toISOString(),
          status: 'VALID',
        };
      }

      return {
        dataSource: 'ZERODHA_LIVE',
        instrumentToken,
        exchange: instrument.exchange,
        segment: instrument.segment,
        instrumentType: instrument.instrumentType,
        tradingSymbol: instrument.tradingsymbol,
        lastPrice: null,
        receivedAt: new Date().toISOString(),
        status: 'UNAVAILABLE',
        diagnosticMessage: 'Upstream returned valid quote structure but last_price is null or invalid',
      };
    } catch (err) {
      if (err instanceof Error) throw err;
      throw new Error('[LiveZerodhaAdapter] Failed to fetch LTP snapshot from Zerodha');
    }
  }

  public async getCapital(
    userId = 'default_trader',
    options: { connectionId?: string } = {}
  ): Promise<BrokerAccountCapital> {
    const connectionId = options.connectionId || 'zerodha';
    const status = await this.getConnectionStatus(userId, { connectionId });
    const isAfterHours = checkIsAfterHours();

    if (status.status !== 'AUTHENTICATED' && status.status !== 'CONNECTED') {
      return {
        broker: 'zerodha',
        dataSource: 'ZERODHA_LIVE',
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
        semanticNote: `Zerodha capital unavailable: ${status.message}`,
      };
    }

    const authSession = await ZerodhaCredentialManager.getAuthenticatedSession(userId, connectionId);
    if (!authSession || !authSession.accessToken) {
      return {
        broker: 'zerodha',
        dataSource: 'ZERODHA_LIVE',
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
        semanticNote: 'Zerodha active session access token not found',
      };
    }

    const { apiKey } = await ZerodhaCredentialManager.getCredentialsForUser(userId, connectionId);

    try {
      const response = await this.fetch('https://api.kite.trade/user/margins', {
        headers: {
          'X-Kite-Version': '3',
          'Authorization': `token ${apiKey || 'zerodha_key'}:${authSession.accessToken}`,
        },
      });

      if (!response.ok) {
        throw new Error(`Kite Connect margins HTTP ${response.status}`);
      }

      const body = await response.json();
      const equityData = body?.data?.equity || body?.data;
      if (!equityData) {
        throw new Error('Invalid margins response structure from Zerodha API');
      }

      const netBalance = Number(equityData.net ?? equityData.available?.cash ?? 0);
      const availableCash = Number(equityData.available?.cash ?? 0);
      const availableTradingMargin = Number(equityData.net ?? equityData.available?.live_balance ?? availableCash);
      const utilizedMargin = Number(
        equityData.utilised?.debits ??
        (Number(equityData.utilised?.exposure || 0) + Number(equityData.utilised?.span || 0) + Number(equityData.utilised?.option_premium || 0))
      );

      return {
        broker: 'zerodha',
        dataSource: 'ZERODHA_LIVE',
        connectionStatus: 'AUTHENTICATED',
        netBalance,
        availableCash,
        availableTradingMargin,
        utilizedMargin,
        withdrawableFunds: null, // Zerodha Kite /user/margins API does not provide a withdrawable balance field
        currency: 'INR',
        asOf: new Date().toISOString(),
        isStale: false,
        isAfterHours,
        semanticNote: 'Mapped from Zerodha Kite Connect /user/margins (equity segment)',
      };
    } catch (err: any) {
      return {
        broker: 'zerodha',
        dataSource: 'ZERODHA_LIVE',
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
        semanticNote: `Failed to fetch Zerodha margins: ${ZerodhaCredentialManager.sanitizeErrorString(err?.message || 'Upstream request failed')}`,
      };
    }
  }
}

export const liveZerodhaAdapter = new LiveZerodhaAdapter();

