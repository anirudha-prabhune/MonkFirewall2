import express, { Request, Response } from 'express';
import { ServerRiskStore } from './risk/store';
import { BrokerService } from './brokers/service';
import { MOCK_INSTRUMENT_MASTER } from './instruments/master';
import { PnlEngine } from './pnl/engine';
import { EnforcementService } from './enforcement/service';
import { requireTradingAccess, generateExtensionToken, verifyExtensionToken, isRequestAuthorizedForUser } from './enforcement/guard';
import { authenticateRequest, requireAuth, resolveUserId } from './auth/session';
import { MarketDataService } from './market/marketDataService';
import { LivePnlValidationService } from './pnl/liveValidationService';
import { ValidationSessionManager } from './pnl/validationSession';
import { ZerodhaCredentialManager } from './brokers/zerodha/credentials';
import { ZerodhaSessionStore } from './brokers/zerodha/sessionStore';
import { liveZerodhaAdapter } from './brokers/zerodha/liveAdapter';
import { mockZerodhaAdapter } from './brokers/mock/adapter';
import { liveAngelOneAdapter } from './brokers/angelone/liveAdapter';
import { mockAngelOneAdapter } from './brokers/angelone/adapter';
import { AngelOneSessionStore, normalizeAngelOneConnectionId } from './brokers/angelone/sessionStore';
import { DEFAULT_ANGELONE_ACCOUNT_ID } from '../src/types/risk';
import { normalizePositions } from './brokers/normalize';
import { BrokerInstrument, LivePositionsResponse } from './brokers/types';
import { ShadowRiskService } from './risk/shadowRiskService';
import {
  LiveRiskRecorder,
  liveRiskStateRecordingEnabled,
  getLiveRiskStateRecordingEnabled,
  setLiveRiskStateRecordingEnabled,
} from './risk/liveRiskRecorder';
import { getTradingDateKolkata } from './risk/engine';
import { ActivationGuardService } from './risk/activationGuard';

export const apiRouter = express.Router();

apiRouter.use(express.json());

function sendJson(res: Response | any, data: any, status = 200) {
  if (typeof res.json === 'function') {
    return res.status(status).json(data);
  }
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(data));
}

function isDemoUser(userId: string, req?: Request): boolean {
  if (userId === 'mock-trader-sandbox' || userId.startsWith('mock-')) {
    return true;
  }
  if (req?.headers['x-demo-mode'] === 'true' || req?.query?.demo === 'true') {
    return true;
  }
  return false;
}

// Health Check
apiRouter.get('/health', (req: Request, res: Response) => {
  sendJson(res, {
    status: 'ok',
    phase: 'PHASE_3',
    service: 'Trading Firewall authoritative risk gateway',
    timestamp: new Date().toISOString(),
    timezone: 'Asia/Kolkata',
    uptimeSeconds: Math.floor(process.uptime()),
    features: {
      firebaseAuth: true,
      firestore: true,
      riskEngine: 'PHASE_2_HARDENED',
      riskConfigValidation: 'ACTIVE',
      lockLifecycle: 'SERVER_AUTHORITATIVE',
      brokerAdapter: 'MOCK_ZERODHA_PHASE_3',
      positionNormalization: 'METADATA_DRIVEN_FNO',
    },
  });
});

// Broker Status (Phase 3 Mock Zerodha)
apiRouter.get('/broker/status', async (req: Request, res: Response) => {
  try {
    const status = await BrokerService.getConnectionStatus();
    sendJson(res, status);
  } catch (err) {
    sendJson(res, { error: err instanceof Error ? err.message : 'Failed to fetch broker status' }, 500);
  }
});

// Legacy Account Status endpoint
apiRouter.get('/account/status', async (req: Request, res: Response) => {
  try {
    const status = await BrokerService.getConnectionStatus();
    sendJson(res, {
      status: status.status,
      broker: status.broker,
      connected: status.status === 'CONNECTED',
      mode: 'MOCK',
      isMock: true,
      message: 'Mock Zerodha Adapter connected (Phase 3 Normalized Positions).',
    });
  } catch (err) {
    sendJson(res, { error: 'Failed' }, 500);
  }
});

// GET /api/positions - All Normalized Positions (Mock Data)
apiRouter.get('/positions', async (req: Request, res: Response) => {
  try {
    const positions = await BrokerService.getNormalizedPositions();
    sendJson(res, {
      dataSource: 'MOCK_DATA',
      count: positions.length,
      positions,
    });
  } catch (err) {
    sendJson(res, { error: err instanceof Error ? err.message : 'Failed to fetch positions' }, 500);
  }
});

// GET /api/positions/fno - Authoritative F&O Positions (Live Zerodha or Mock Fallback)
apiRouter.get('/positions/fno', async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId || await authenticateRequest(req, res);
    if (!userId) return;

    const accountId = (req.query?.accountId as string) || (req.headers['x-account-id'] as string) || undefined;
    const isAngelOne = (accountId && (accountId === 'acc_mt_angelone_default' || accountId.includes('angelone'))) || req.query?.broker === 'angelone' || req.headers['x-broker'] === 'angelone';

    if (isAngelOne) {
      const connStatus = await liveAngelOneAdapter.getConnectionStatus(userId, { connectionId: accountId });
      const isAngelConnected = connStatus.authenticated === true && (connStatus.status === 'CONNECTED' || connStatus.status === 'AUTHENTICATED');
      if (isAngelConnected) {
        try {
          const rawPositions = await liveAngelOneAdapter.getPositions(userId, { connectionId: accountId });
          const instruments = await liveAngelOneAdapter.getInstruments(userId);
          const instrumentMap = new Map<number, BrokerInstrument>(instruments.map((i: BrokerInstrument) => [i.instrumentToken, i]));
          const normalized = normalizePositions(rawPositions, instrumentMap, 'ANGELONE_LIVE');
          const fnoPositions = normalized.filter((p) => p.isFno === true && !p.unknownInstrument);
          return sendJson(res, {
            dataSource: 'ANGELONE_LIVE',
            connectionStatus: connStatus.status,
            count: fnoPositions.length,
            positions: fnoPositions,
          });
        } catch (err: any) {
          console.info('[AngelOne] Positions unavailable for session:', err?.message || err);
          const updatedStatus = await liveAngelOneAdapter.getConnectionStatus(userId, { connectionId: accountId });
          return sendJson(res, {
            dataSource: 'ANGELONE_LIVE',
            connectionStatus: updatedStatus.status,
            diagnosticNote: err instanceof Error ? err.message : String(err),
            count: 0,
            positions: [],
          });
        }
      }
      return sendJson(res, {
        dataSource: 'ANGELONE_LIVE',
        connectionStatus: connStatus.status,
        diagnosticNote: connStatus.message || 'Angel One session not authenticated',
        count: 0,
        positions: [],
      });
    }

    const liveAdapter = BrokerService.getLiveAdapter();
    const connStatus = await liveAdapter.getConnectionStatus(userId);

    // If Zerodha is authenticated and connected, return validated real live positions
    if (connStatus.status === 'CONNECTED' && connStatus.authenticated) {
      const config = await ServerRiskStore.getConfig(userId, accountId);
      const validationResult = await LivePnlValidationService.validateLivePnl(
        config,
        new Date(),
        undefined,
        undefined,
        userId
      );

      // Do not fall back to mock data if live connection is active
      if (
        validationResult.validationState !== 'AUTHENTICATION_REQUIRED' &&
        validationResult.validationState !== 'ERROR'
      ) {
        const livePositions = validationResult.positions || [];
        return sendJson(res, {
          dataSource: 'ZERODHA_LIVE',
          count: livePositions.length,
          positions: livePositions,
          validationState: validationResult.validationState,
          marketDataStatus: validationResult.marketDataStatus,
        });
      }
    }

    // Preserve existing simulation mode when live data is unavailable
    const fnoPositions = await BrokerService.getNormalizedFnoPositions();
    sendJson(res, {
      dataSource: 'MOCK_DATA',
      count: fnoPositions.length,
      positions: fnoPositions,
    });
  } catch (err) {
    sendJson(res, { error: err instanceof Error ? err.message : 'Failed to fetch F&O positions' }, 500);
  }
});

// POST /api/positions/sync - Sync positions for current user
apiRouter.post('/positions/sync', async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId || await authenticateRequest(req, res);
    if (!userId) return;
    const result = await BrokerService.syncPositions(userId);
    sendJson(res, {
      success: true,
      dataSource: 'MOCK_DATA',
      fnoCount: result.fno.length,
      totalCount: result.all.length,
      positions: result.fno,
    });
  } catch (err) {
    sendJson(res, { error: err instanceof Error ? err.message : 'Failed to sync positions' }, 500);
  }
});

// GET /api/instruments - Mock Instrument Master
apiRouter.get('/instruments', (req: Request, res: Response) => {
  sendJson(res, {
    count: MOCK_INSTRUMENT_MASTER.length,
    instruments: MOCK_INSTRUMENT_MASTER,
  });
});

// GET /api/broker/live/status - Phase 7 Live Zerodha Diagnostic Connection Status
apiRouter.get('/broker/live/status', async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId || await authenticateRequest(req, res);
    if (!userId) return;
    const status = await BrokerService.getLiveDiagnosticStatus(userId);
    sendJson(res, status);
  } catch (err) {
    sendJson(res, { error: err instanceof Error ? err.message : 'Failed to retrieve live broker status' }, 500);
  }
});

// GET /api/broker/live/auth/login - Daily Kite Connect Login Flow (Phase 8A)
apiRouter.get('/broker/live/auth/login', async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId || await authenticateRequest(req, res);
    if (!userId) return;
    const redirectUrl = req.query.redirect_url as string | undefined;
    const loginResult = ZerodhaCredentialManager.getLoginUrlWithState(redirectUrl, userId);
    sendJson(res, { loginUrl: loginResult.url, state: loginResult.state, userId });
  } catch (err) {
    sendJson(
      res,
      {
        error: 'CONFIGURATION_ERROR',
        message: err instanceof Error ? err.message : 'Failed to generate Kite login URL',
      },
      400
    );
  }
});

// Daily Kite Connect Redirect Callback (GET for browser redirect, POST for direct token submission)
const handleAuthCallback = async (req: Request, res: Response) => {
  try {
    const statusParam = (req.query.status || req.body?.status) as string | undefined;
    if (statusParam === 'error' || req.query.error || req.body?.error) {
      const errorMsg = (req.query.message || req.body?.message || req.query.error_description || req.query.error || 'Authentication denied or failed') as string;
      ZerodhaCredentialManager.setAuthState('AUTHENTICATION_ERROR');
      if (req.accepts('html') && req.method === 'GET') {
        return res.redirect(`/?zerodha_auth=error&error=${encodeURIComponent(ZerodhaCredentialManager.sanitizeErrorString(errorMsg))}`);
      }
      return sendJson(res, { success: false, error: ZerodhaCredentialManager.sanitizeErrorString(errorMsg) }, 400);
    }

    const requestToken = (req.query.request_token || req.query.token || req.body?.request_token || req.body?.token) as string | undefined;
    if (!requestToken || requestToken.trim().length === 0) {
      return sendJson(res, { error: 'INVALID_REQUEST', message: 'Missing request_token parameter from Zerodha redirect' }, 400);
    }

    // If arbitrary user_id query parameter is provided without signed state: REJECT
    if (req.query.user_id || req.query.userId) {
      const candidateState = (req.query.state || req.body?.state) as string | undefined;
      if (!candidateState) {
        return sendJson(
          res,
          {
            error: 'INVALID_OAUTH_STATE',
            message: 'Arbitrary userId via query parameters without a valid signed state parameter is forbidden.',
          },
          400
        );
      }
    }

    const stateParam = (req.query.state || req.body?.state) as string | undefined;
    if (!stateParam || typeof stateParam !== 'string' || !stateParam.trim()) {
      return sendJson(
        res,
        {
          error: 'MISSING_OAUTH_STATE',
          message: 'Production OAuth callbacks must provide a valid signed state parameter.',
        },
        400
      );
    }

    const stateResult = ZerodhaCredentialManager.verifyOAuthState(stateParam.trim());
    if (!stateResult.valid || !stateResult.userId) {
      const isExpired = stateResult.error === 'EXPIRED_OAUTH_STATE';
      return sendJson(
        res,
        {
          error: isExpired ? 'EXPIRED_OAUTH_STATE' : 'INVALID_OAUTH_STATE',
          message: `OAuth state verification failed: ${stateResult.error || 'tampered or expired state'}`,
        },
        400
      );
    }

    const verifiedUserId = stateResult.userId;

    const exchangeResult = await ZerodhaCredentialManager.exchangeRequestToken(requestToken.trim(), verifiedUserId);
    if (!exchangeResult.success) {
      if (req.accepts('html') && req.method === 'GET') {
        return res.redirect(`/?zerodha_auth=error&error=${encodeURIComponent(exchangeResult.error || 'Token exchange failed')}`);
      }
      const statusCode = exchangeResult.error?.includes('SESSION_PERSISTENCE_ERROR') ? 500 : 401;
      return sendJson(res, { success: false, error: exchangeResult.error }, statusCode);
    }

    if (req.accepts('html') && req.method === 'GET') {
      return res.redirect('/?zerodha_auth=success');
    }

    sendJson(res, {
      success: true,
      authenticated: true,
      status: 'AUTHENTICATED',
      userId: verifiedUserId,
      session: exchangeResult.session ? ZerodhaCredentialManager.sanitize(exchangeResult.session) : undefined,
    });
  } catch (err) {
    const rawMsg = err instanceof Error ? err.message : 'Unknown error during authentication callback';
    sendJson(res, { error: ZerodhaCredentialManager.sanitizeErrorString(rawMsg) }, 500);
  }
};

apiRouter.get('/broker/live/auth/callback', handleAuthCallback);
apiRouter.post('/broker/live/auth/callback', handleAuthCallback);
apiRouter.post('/brokers/zerodha/callback', handleAuthCallback);

// POST /api/broker/live/auth/disconnect - Invalidate Active Zerodha Session (Phase 8A)
apiRouter.post('/broker/live/auth/disconnect', async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId || await authenticateRequest(req, res);
    if (!userId) return;
    await ZerodhaCredentialManager.disconnect(userId);
    sendJson(res, {
      success: true,
      status: 'AUTHENTICATION_REQUIRED',
      message: 'Active Zerodha session invalidated. Re-authentication required for live data.',
    });
  } catch (err) {
    sendJson(res, { error: err instanceof Error ? err.message : 'Failed to disconnect session' }, 500);
  }
});

// POST /api/broker/live/auth/logout - Alias for disconnect
apiRouter.post('/broker/live/auth/logout', async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId || await authenticateRequest(req, res);
    if (!userId) return;
    await ZerodhaCredentialManager.disconnect(userId);
    sendJson(res, {
      success: true,
      status: 'AUTHENTICATION_REQUIRED',
      message: 'Active Zerodha session invalidated. Re-authentication required for live data.',
    });
  } catch (err) {
    sendJson(res, { error: err instanceof Error ? err.message : 'Failed to disconnect session' }, 500);
  }
});

// GET /api/broker/live/diagnostic/session - Phase 8A Sanitized Session Continuity Diagnostic
apiRouter.get('/broker/live/diagnostic/session', async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId || await authenticateRequest(req, res);
    if (!userId) return;
    const activeSession = await ZerodhaCredentialManager.getAuthenticatedSession(userId);
    const presence = ZerodhaCredentialManager.getPresenceDiagnostic(userId);

    sendJson(res, {
      broker: 'zerodha',
      authenticated: Boolean(activeSession && activeSession.accessToken),
      status: activeSession ? 'AUTHENTICATED' : 'AUTHENTICATION_REQUIRED',
      sessionSource: activeSession?.source || 'NONE',
      sessionVersion: activeSession?.sessionVersion ?? null,
      expiresAt: activeSession?.expiresAt || presence.expiresAt,
      tradingDate: activeSession?.tradingDateKolkata || null,
      runtimeInstance: `inst-${process.pid}-${process.platform}`,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    sendJson(res, { error: err instanceof Error ? err.message : 'Failed to retrieve diagnostic' }, 500);
  }
});

// GET /api/broker/live/positions - Phase 7 Live Read-Only Normalized Positions
apiRouter.get('/broker/live/positions', async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId || await authenticateRequest(req, res);
    if (!userId) return;
    const accountId = (req.query?.accountId as string) || (req.headers['x-account-id'] as string) || undefined;
    const isAngelOne = (accountId && (accountId === 'acc_mt_angelone_default' || accountId.includes('angelone'))) || req.query?.broker === 'angelone' || req.headers['x-broker'] === 'angelone';

    if (isAngelOne) {
      const status = await liveAngelOneAdapter.getConnectionStatus(userId, { connectionId: accountId });
      if (status.status !== 'AUTHENTICATED' && status.status !== 'CONNECTED') {
        return sendJson(res, {
          broker: 'angelone',
          connectionStatus: status.status,
          dataSource: 'ANGELONE_LIVE',
          positionCount: 0,
          fnoPositionCount: 0,
          positions: [],
          timestamp: new Date().toISOString(),
          diagnosticNote: 'Angel One not authenticated',
        });
      }
      try {
        const rawPositions = await liveAngelOneAdapter.getPositions(userId, { connectionId: accountId });
        const instruments = await liveAngelOneAdapter.getInstruments(userId);
        const instrumentMap = new Map<number, BrokerInstrument>(instruments.map((i: BrokerInstrument) => [i.instrumentToken, i]));
        const normalized = normalizePositions(rawPositions, instrumentMap, 'ANGELONE_LIVE');
        const fnoPositions = normalized.filter((p) => p.isFno === true && !p.unknownInstrument);
        const response: LivePositionsResponse = {
          broker: 'angelone',
          connectionStatus: status.status,
          dataSource: 'ANGELONE_LIVE',
          positionCount: normalized.length,
          fnoPositionCount: fnoPositions.length,
          positions: normalized,
          timestamp: new Date().toISOString(),
          diagnosticNote: 'Positions normalized via Angel One live adapter',
        };
        return sendJson(res, response);
      } catch (posErr: any) {
        console.info('[AngelOne] Live diagnostic positions unavailable:', posErr?.message || posErr);
        const updatedStatus = await liveAngelOneAdapter.getConnectionStatus(userId, { connectionId: accountId });
        return sendJson(res, {
          broker: 'angelone',
          connectionStatus: updatedStatus.status,
          dataSource: 'ANGELONE_LIVE',
          positionCount: 0,
          fnoPositionCount: 0,
          positions: [],
          timestamp: new Date().toISOString(),
          diagnosticNote: posErr instanceof Error ? posErr.message : 'Failed to fetch live Angel One positions',
        });
      }
    }

    const livePositions = await BrokerService.getLiveDiagnosticPositions(userId);
    sendJson(res, livePositions);
  } catch (err) {
    sendJson(res, { error: err instanceof Error ? err.message : 'Failed to fetch live positions' }, 500);
  }
});

// GET /api/broker/live/capital - Phase 5B Read-Only Account Capital (Zerodha / Angel One / Mock)
apiRouter.get('/broker/live/capital', async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId || await authenticateRequest(req, res);
    if (!userId) return;

    const accountId = (req.query?.accountId as string) || (req.headers['x-account-id'] as string) || undefined;
    const isExplicitMock = req.query?.mode === 'mock' || req.query?.broker === 'mock';
    const isAngelOne = (accountId && (accountId === 'acc_mt_angelone_default' || accountId.includes('angelone'))) || req.query?.broker === 'angelone' || req.headers['x-broker'] === 'angelone';

    const capital = isExplicitMock
      ? await mockZerodhaAdapter.getCapital()
      : isAngelOne
      ? await liveAngelOneAdapter.getCapital(userId, { connectionId: accountId })
      : await liveZerodhaAdapter.getCapital(userId);

    sendJson(res, {
      success: true,
      broker: isExplicitMock ? 'mock' : isAngelOne ? 'angelone' : 'zerodha',
      capital,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    sendJson(res, {
      success: false,
      broker: 'zerodha',
      capital: null,
      error: err instanceof Error ? err.message : 'Failed to fetch account capital',
      timestamp: new Date().toISOString(),
    }, 500);
  }
});

// ============================================================================
// ANGEL ONE SMARTAPI ENDPOINTS (PHASE 1 MULTI-BROKER)
// ============================================================================

apiRouter.get('/broker/angelone/live/status', async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId || await authenticateRequest(req, res);
    if (!userId) return;
    const accountId = (req.query?.accountId as string) || (req.headers['x-account-id'] as string) || undefined;
    const status = await liveAngelOneAdapter.getConnectionStatus(userId, { connectionId: accountId });
    sendJson(res, status);
  } catch (err) {
    sendJson(res, { error: err instanceof Error ? err.message : 'Failed to retrieve Angel One status' }, 500);
  }
});

apiRouter.get('/broker/angelone/live/positions', async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId || await authenticateRequest(req, res);
    if (!userId) return;
    const accountId = (req.query?.accountId as string) || (req.headers['x-account-id'] as string) || undefined;
    const status = await liveAngelOneAdapter.getConnectionStatus(userId, { connectionId: accountId });
    if (status.status !== 'AUTHENTICATED' && status.status !== 'CONNECTED') {
      return sendJson(res, {
        broker: 'angelone',
        connectionStatus: status.status,
        dataSource: 'ANGELONE_LIVE',
        positionCount: 0,
        fnoPositionCount: 0,
        positions: null,
        isUnavailable: true,
        timestamp: new Date().toISOString(),
        diagnosticNote: 'Angel One not authenticated',
      });
    }
    try {
      const rawPositions = await liveAngelOneAdapter.getPositions(userId, { connectionId: accountId });
      const instruments = await liveAngelOneAdapter.getInstruments(userId);
      const instrumentMap = new Map<number, BrokerInstrument>(instruments.map((i: BrokerInstrument) => [i.instrumentToken, i]));
      const normalized = normalizePositions(rawPositions, instrumentMap, 'ANGELONE_LIVE');
      const fnoPositions = normalized.filter((p) => p.isFno === true && !p.unknownInstrument);
      const response: LivePositionsResponse = {
        broker: 'angelone',
        connectionStatus: status.status,
        dataSource: 'ANGELONE_LIVE',
        positionCount: normalized.length,
        fnoPositionCount: fnoPositions.length,
        positions: normalized,
        timestamp: new Date().toISOString(),
        diagnosticNote: 'Positions normalized via Angel One live adapter',
      };
      sendJson(res, response);
    } catch (posErr: any) {
      console.info('[AngelOne] Live positions unavailable:', posErr?.message || posErr);
      const updatedStatus = await liveAngelOneAdapter.getConnectionStatus(userId, { connectionId: accountId });
      sendJson(res, {
        broker: 'angelone',
        connectionStatus: updatedStatus.status,
        dataSource: 'ANGELONE_LIVE',
        positionCount: 0,
        fnoPositionCount: 0,
        positions: null,
        isStale: true,
        isUnavailable: true,
        error: posErr instanceof Error ? posErr.message : 'Failed to fetch Angel One positions',
        timestamp: new Date().toISOString(),
        diagnosticNote: posErr instanceof Error ? posErr.message : 'Failed to fetch Angel One positions',
      }, 502);
    }
  } catch (err) {
    sendJson(res, { error: err instanceof Error ? err.message : 'Failed to fetch Angel One positions' }, 500);
  }
});

apiRouter.get('/broker/angelone/live/capital', async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId || await authenticateRequest(req, res);
    if (!userId) return;
    const accountId = (req.query?.accountId as string) || (req.headers['x-account-id'] as string) || undefined;
    const capital = await liveAngelOneAdapter.getCapital(userId, { connectionId: accountId });
    sendJson(res, {
      success: true,
      broker: 'angelone',
      capital,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    sendJson(res, {
      success: false,
      broker: 'angelone',
      capital: null,
      error: err instanceof Error ? err.message : 'Failed to fetch Angel One account capital',
      timestamp: new Date().toISOString(),
    }, 500);
  }
});

apiRouter.post('/broker/angelone/live/auth/session', async (req: Request, res: Response) => {
  try {
    const userId = await authenticateRequest(req, res);
    if (!userId) return;

    // Never accept client-supplied accessToken as proof of authentication
    const { clientCode, password, totp, apiKey, accountId, connectionId } = req.body || {};
    const targetAccountId = accountId || connectionId || (req.headers['x-account-id'] as string) || undefined;

    const authResult = await liveAngelOneAdapter.authenticate(
      userId,
      {
        clientCode,
        password,
        totp,
        apiKey,
      },
      {
        connectionId: targetAccountId,
      }
    );

    if (!authResult.success) {
      return sendJson(
        res,
        {
          success: false,
          error: authResult.error || 'Angel One authentication failed',
        },
        401
      );
    }

    sendJson(res, {
      success: true,
      authenticated: true,
      status: 'AUTHENTICATED',
      authState: 'AUTHENTICATED',
      clientCode: authResult.session?.clientCode,
      sessionVersion: authResult.session?.sessionVersion,
      expiresAt: authResult.session?.expiresAt,
    });
  } catch (err) {
    sendJson(
      res,
      {
        success: false,
        error: err instanceof Error ? err.message : 'Failed to authenticate Angel One session',
      },
      500
    );
  }
});

apiRouter.post('/broker/angelone/live/auth/disconnect', async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId || await authenticateRequest(req, res);
    if (!userId) return;
    const accountId = (req.body?.accountId as string) || (req.query?.accountId as string) || (req.headers['x-account-id'] as string) || undefined;
    await AngelOneSessionStore.invalidateSession(userId, undefined, accountId);
    sendJson(res, { success: true, status: 'AUTHENTICATION_REQUIRED', message: 'Angel One session invalidated.' });
  } catch (err) {
    sendJson(res, { error: err instanceof Error ? err.message : 'Failed to disconnect Angel One session' }, 500);
  }
});

// ============================================================================
// UNIFIED BROKER ONBOARDING & CREDENTIAL MANAGEMENT (MONKFIREWALL2)
// ============================================================================

// Save/Onboard Broker Credentials: POST & PUT /api/broker/credentials & /api/broker/:broker/credentials
const handleSaveCredentials = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId || await authenticateRequest(req, res);
    if (!userId) return;

    if (isDemoUser(userId, req)) {
      return sendJson(res, { success: false, error: 'DEMO_MODE_RESTRICTION', message: 'Broker connections and credentials cannot be modified in Demo Mode.' }, 403);
    }

    const paramBroker = (req.params.broker || req.body?.broker || '').toLowerCase();
    const accountId = (req.body?.accountId as string) || (req.body?.connectionId as string) || (req.query?.accountId as string) || (req.headers['x-account-id'] as string) || undefined;

    if (paramBroker === 'zerodha') {
      const { apiKey, apiSecret } = req.body || {};
      if (!apiKey || !apiKey.trim() || !apiSecret || !apiSecret.trim()) {
        return sendJson(res, { success: false, error: 'Both Zerodha API Key and API Secret are required.' }, 400);
      }
      const connectionId = accountId || 'zerodha';
      await ZerodhaSessionStore.saveCredentials(userId, { apiKey: apiKey.trim(), apiSecret: apiSecret.trim() }, connectionId);
      const diagnostic = ZerodhaCredentialManager.getPresenceDiagnostic(userId);
      return sendJson(res, {
        success: true,
        broker: 'zerodha',
        connectionId,
        configured: true,
        credentials: diagnostic,
        message: 'Zerodha credentials encrypted and stored successfully.',
      });
    } else if (paramBroker === 'angelone') {
      const { apiKey, clientCode, password, totpSecret } = req.body || {};
      if (!apiKey || !apiKey.trim() || !clientCode || !clientCode.trim() || !password || !password.trim()) {
        return sendJson(res, { success: false, error: 'Angel One API Key, Client Code, and Password are required.' }, 400);
      }
      const connectionId = accountId || DEFAULT_ANGELONE_ACCOUNT_ID;
      await AngelOneSessionStore.saveCredentials(
        userId,
        {
          apiKey: apiKey.trim(),
          clientCode: clientCode.trim(),
          password: password.trim(),
          ...(totpSecret && totpSecret.trim() ? { totpSecret: totpSecret.trim() } : {}),
        },
        connectionId
      );
      const status = await liveAngelOneAdapter.getConnectionStatus(userId, { connectionId });
      return sendJson(res, {
        success: true,
        broker: 'angelone',
        connectionId,
        configured: true,
        credentials: {
          apiKeyConfigured: true,
          clientCodeConfigured: true,
          passwordConfigured: true,
          totpSecretConfigured: Boolean(totpSecret && totpSecret.trim()),
        },
        connectionStatus: status.status,
        message: 'Angel One credentials encrypted and stored successfully.',
      });
    } else {
      return sendJson(res, { success: false, error: 'Invalid broker specified. Supported brokers: zerodha, angelone.' }, 400);
    }
  } catch (err: any) {
    sendJson(res, { success: false, error: ZerodhaCredentialManager.sanitizeErrorString(err?.message || 'Failed to save broker credentials') }, 500);
  }
};

apiRouter.post('/broker/credentials', handleSaveCredentials);
apiRouter.put('/broker/credentials', handleSaveCredentials);
apiRouter.post('/broker/:broker/credentials', handleSaveCredentials);
apiRouter.put('/broker/:broker/credentials', handleSaveCredentials);

// Get Broker Credential Status: GET /api/broker/credentials & /api/broker/:broker/credentials
const handleGetCredentials = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId || await authenticateRequest(req, res);
    if (!userId) return;

    const rawParam = req.params.broker || req.query?.broker || '';
    const paramBroker = (Array.isArray(rawParam) ? String(rawParam[0]) : String(rawParam)).toLowerCase();
    const accountId = (req.query?.accountId as string) || (req.headers['x-account-id'] as string) || undefined;

    if (!paramBroker || paramBroker === 'all') {
      const zerodhaCreds = await ZerodhaSessionStore.loadCredentials(userId, accountId || 'zerodha');
      const angelCreds = await AngelOneSessionStore.loadCredentials(userId, accountId || DEFAULT_ANGELONE_ACCOUNT_ID);
      const zerodhaStatus = await liveZerodhaAdapter.getConnectionStatus(userId, { connectionId: accountId || 'zerodha' });
      const angelStatus = await liveAngelOneAdapter.getConnectionStatus(userId, { connectionId: accountId || DEFAULT_ANGELONE_ACCOUNT_ID });

      return sendJson(res, {
        userId,
        zerodha: {
          configured: Boolean(zerodhaCreds || process.env.ZERODHA_API_KEY),
          connectionStatus: zerodhaStatus.status,
          diagnostic: ZerodhaCredentialManager.getPresenceDiagnostic(userId),
        },
        angelone: {
          configured: Boolean(angelCreds),
          connectionStatus: angelStatus.status,
          diagnostic: {
            apiKeyConfigured: Boolean(angelCreds?.apiKey),
            clientCodeConfigured: Boolean(angelCreds?.clientCode),
            passwordConfigured: Boolean(angelCreds?.password),
            totpSecretConfigured: Boolean(angelCreds?.totpSecret),
          },
        },
      });
    }

    if (paramBroker === 'zerodha') {
      const connId = accountId || 'zerodha';
      const zerodhaCreds = await ZerodhaSessionStore.loadCredentials(userId, connId);
      const zerodhaStatus = await liveZerodhaAdapter.getConnectionStatus(userId, { connectionId: connId });
      return sendJson(res, {
        broker: 'zerodha',
        connectionId: connId,
        configured: Boolean(zerodhaCreds || process.env.ZERODHA_API_KEY),
        connectionStatus: zerodhaStatus.status,
        diagnostic: ZerodhaCredentialManager.getPresenceDiagnostic(userId),
      });
    } else if (paramBroker === 'angelone') {
      const connId = accountId || DEFAULT_ANGELONE_ACCOUNT_ID;
      const angelCreds = await AngelOneSessionStore.loadCredentials(userId, connId);
      const angelStatus = await liveAngelOneAdapter.getConnectionStatus(userId, { connectionId: connId });
      return sendJson(res, {
        broker: 'angelone',
        connectionId: connId,
        configured: Boolean(angelCreds),
        connectionStatus: angelStatus.status,
        diagnostic: {
          apiKeyConfigured: Boolean(angelCreds?.apiKey),
          clientCodeConfigured: Boolean(angelCreds?.clientCode),
          passwordConfigured: Boolean(angelCreds?.password),
          totpSecretConfigured: Boolean(angelCreds?.totpSecret),
        },
      });
    } else {
      return sendJson(res, { success: false, error: 'Invalid broker specified. Supported brokers: zerodha, angelone.' }, 400);
    }
  } catch (err: any) {
    sendJson(res, { error: err?.message || 'Failed to retrieve credential status' }, 500);
  }
};

apiRouter.get('/broker/credentials', handleGetCredentials);
apiRouter.get('/broker/:broker/credentials', handleGetCredentials);

// Delete Broker Credentials: DELETE /api/broker/credentials & /api/broker/:broker/credentials
const handleDeleteCredentials = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId || await authenticateRequest(req, res);
    if (!userId) return;

    const paramBroker = (req.params.broker || req.body?.broker || req.query?.broker || '').toLowerCase();
    const accountId = (req.body?.accountId as string) || (req.query?.accountId as string) || (req.headers['x-account-id'] as string) || undefined;

    if (paramBroker === 'zerodha') {
      const connId = accountId || 'zerodha';
      await ZerodhaSessionStore.deleteCredentials(userId, connId);
      return sendJson(res, {
        success: true,
        broker: 'zerodha',
        connectionId: connId,
        configured: false,
        message: 'Zerodha credentials removed and runtime session invalidated.',
      });
    } else if (paramBroker === 'angelone') {
      const connId = accountId || DEFAULT_ANGELONE_ACCOUNT_ID;
      await AngelOneSessionStore.deleteCredentials(userId, connId);
      return sendJson(res, {
        success: true,
        broker: 'angelone',
        connectionId: connId,
        configured: false,
        message: 'Angel One credentials removed and runtime session invalidated.',
      });
    } else {
      return sendJson(res, { success: false, error: 'Invalid broker specified. Supported brokers: zerodha, angelone.' }, 400);
    }
  } catch (err: any) {
    sendJson(res, { error: err?.message || 'Failed to remove credentials' }, 500);
  }
};

apiRouter.delete('/broker/credentials', handleDeleteCredentials);
apiRouter.delete('/broker/:broker/credentials', handleDeleteCredentials);

// Reconnect / Authenticate Broker Session: POST /api/broker/:broker/reconnect & /api/broker/:broker/connect
const handleReconnectBroker = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId || await authenticateRequest(req, res);
    if (!userId) return;

    if (isDemoUser(userId, req)) {
      return sendJson(res, { success: false, error: 'DEMO_MODE_RESTRICTION', message: 'Broker connections and credentials cannot be modified in Demo Mode.' }, 403);
    }

    const paramBroker = (req.params.broker || req.body?.broker || '').toLowerCase();
    const accountId = (req.body?.accountId as string) || (req.query?.accountId as string) || (req.headers['x-account-id'] as string) || undefined;

    if (paramBroker === 'zerodha') {
      const connId = accountId || 'zerodha';
      const redirectUrl = (req.body?.redirect_url || req.query?.redirect_url) as string | undefined;
      const loginRes = await ZerodhaCredentialManager.getLoginUrlWithStateForUser(redirectUrl, userId, connId);
      return sendJson(res, {
        success: true,
        broker: 'zerodha',
        connectionId: connId,
        loginUrl: loginRes.url,
        state: loginRes.state,
      });
    } else if (paramBroker === 'angelone') {
      const connId = accountId || DEFAULT_ANGELONE_ACCOUNT_ID;
      const authResult = await liveAngelOneAdapter.authenticate(userId, req.body || {}, { connectionId: connId });
      if (!authResult.success) {
        return sendJson(res, { success: false, broker: 'angelone', error: authResult.error }, 401);
      }
      return sendJson(res, {
        success: true,
        broker: 'angelone',
        connectionId: connId,
        status: 'AUTHENTICATED',
        sessionVersion: authResult.session?.sessionVersion,
        expiresAt: authResult.session?.expiresAt,
      });
    } else {
      return sendJson(res, { success: false, error: 'Invalid broker specified.' }, 400);
    }
  } catch (err: any) {
    sendJson(res, { error: ZerodhaCredentialManager.sanitizeErrorString(err?.message || 'Failed to reconnect broker session') }, 500);
  }
};

apiRouter.post('/broker/reconnect', handleReconnectBroker);
apiRouter.post('/broker/:broker/reconnect', handleReconnectBroker);
apiRouter.post('/broker/:broker/connect', handleReconnectBroker);

// GET /api/broker/live/market-data/status - Phase 7 Read-Only Market Data Feed Status
apiRouter.get('/broker/live/market-data/status', async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId || await authenticateRequest(req, res);
    if (!userId) return;
    const status = MarketDataService.getStatus();
    sendJson(res, status);
  } catch (err) {
    sendJson(res, { error: err instanceof Error ? err.message : 'Failed to fetch market data status' }, 500);
  }
});

// GET /api/broker/live/ltp - Phase 8A Read-Only Live Zerodha REST LTP Snapshot
apiRouter.get('/broker/live/ltp', async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId || await authenticateRequest(req, res);
    if (!userId) return;

    const tokenParam = (req.query.instrument_token || req.query.instrumentToken) as string;
    if (!tokenParam) {
      return sendJson(res, { error: 'INVALID_REQUEST', message: 'Missing instrument_token parameter' }, 400);
    }

    const instrumentToken = parseInt(tokenParam, 10);
    if (!Number.isInteger(instrumentToken) || instrumentToken <= 0) {
      return sendJson(res, { error: 'INVALID_REQUEST', message: 'Invalid instrument_token: must be positive integer' }, 400);
    }

    const snapshot = await BrokerService.getLiveAdapter().getLtpSnapshot(instrumentToken, userId);
    sendJson(res, snapshot);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to fetch LTP snapshot';
    const isAuthErr = msg.includes('Authentication failure') || msg.includes('TokenException') || msg.includes('access token');
    const isValidationErr = msg.includes('Unknown instrument') || msg.includes('Non-F&O');
    const statusCode = isAuthErr ? 403 : isValidationErr ? 400 : 500;

    sendJson(
      res,
      {
        dataSource: 'ZERODHA_LIVE',
        status: 'ERROR',
        error: ZerodhaCredentialManager.sanitizeErrorString(msg),
      },
      statusCode
    );
  }
});

// GET /api/pnl - Authoritative Gross F&O P&L (Live Zerodha, Live Angel One, or Mock Fallback)
apiRouter.get('/pnl', async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId || await authenticateRequest(req, res);
    if (!userId) return;

    const accountId = (req.query?.accountId as string) || (req.headers['x-account-id'] as string) || undefined;
    const config = await ServerRiskStore.getConfig(userId, accountId);

    // Isolated Simulation Check: Serve active simulation session if active
    const simSession = await ServerRiskStore.getSimulatedSession(userId, accountId);
    if (simSession && simSession.isSimulated === true) {
      const simPnl = simSession.simulatedPnl ?? simSession.currentPnl ?? 0;
      const simLoss = simSession.lossAmount ?? (simPnl < 0 ? Math.abs(simPnl) : 0);
      return sendJson(res, {
        tradingDate: simSession.tradingDate,
        realisedPnl: simSession.realisedPnl ?? simPnl,
        unrealisedPnl: simSession.unrealisedPnl ?? 0,
        totalPnl: simPnl,
        grossTradingPnl: simPnl,
        dailyRealisedPnl: simSession.realisedPnl ?? simPnl,
        dailyUnrealisedPnl: simSession.unrealisedPnl ?? 0,
        fnoPositionCount: 0,
        totalPositionCount: 0,
        positions: [],
        source: 'SYNTHETIC_SIMULATION' as const,
        dataSource: 'SYNTHETIC_SIMULATION' as const,
        calculatedAt: new Date().toISOString(),
        riskSession: simSession,
        shadowSession: simSession,
        state: simSession.state,
        currentPnl: simPnl,
        lossAmount: simLoss,
        dailyLossLimit: config.dailyLossLimit,
        executionMode: config.executionMode || 'ENFORCE',
        lossUtilizedPercent: Math.min(100, Math.round((simLoss / config.dailyLossLimit) * 100)),
        warningThreshold1: config.warningThreshold1,
        warningThreshold2: config.warningThreshold2,
        isBreached: simSession.isBreached,
        isSimulated: true,
      });
    }

    const isAngelOne = (accountId && (accountId === 'acc_mt_angelone_default' || accountId.includes('angelone'))) || req.query?.broker === 'angelone' || req.headers['x-broker'] === 'angelone';

    if (isAngelOne) {
      const connStatus = await liveAngelOneAdapter.getConnectionStatus(userId, { connectionId: accountId });
      const isAngelConnected = connStatus.authenticated === true && (connStatus.status === 'CONNECTED' || connStatus.status === 'AUTHENTICATED');
      if (isAngelConnected) {
        try {
          const rawPositions = await liveAngelOneAdapter.getPositions(userId, { connectionId: accountId });
          const instruments = await liveAngelOneAdapter.getInstruments(userId);
          const instrumentMap = new Map<number, BrokerInstrument>(instruments.map((i: BrokerInstrument) => [i.instrumentToken, i]));
          const normalized = normalizePositions(rawPositions, instrumentMap, 'ANGELONE_LIVE');
          const fnoPositions = normalized.filter((p) => p.isFno === true && !p.unknownInstrument);
          const pnlCalc = PnlEngine.calculate(fnoPositions, config);
          const evalResult = await ServerRiskStore.evaluatePnlResult(userId, pnlCalc, new Date(), config, accountId);
          const accountSession = evalResult.session;

          return sendJson(res, {
            tradingDate: pnlCalc.tradingDate,
            realisedPnl: pnlCalc.realisedPnl,
            unrealisedPnl: pnlCalc.unrealisedPnl,
            totalPnl: pnlCalc.totalPnl,
            grossTradingPnl: pnlCalc.grossTradingPnl,
            dailyRealisedPnl: pnlCalc.dailyRealisedPnl,
            dailyUnrealisedPnl: pnlCalc.dailyUnrealisedPnl,
            fnoPositionCount: fnoPositions.length,
            totalPositionCount: fnoPositions.length,
            positions: fnoPositions,
            source: 'ANGELONE_LIVE' as const,
            dataSource: 'ANGELONE_LIVE' as const,
            calculatedAt: new Date().toISOString(),
            riskSession: accountSession,
            shadowSession: accountSession,
            state: accountSession.state,
            currentPnl: pnlCalc.grossTradingPnl,
            lossAmount: accountSession.lossAmount ?? (pnlCalc.grossTradingPnl < 0 ? Math.abs(pnlCalc.grossTradingPnl) : 0),
            dailyLossLimit: config.dailyLossLimit,
            executionMode: config.executionMode || 'ENFORCE',
            lossUtilizedPercent: evalResult.lossUtilizedPercent,
            warningThreshold1: config.warningThreshold1,
            warningThreshold2: config.warningThreshold2,
            isBreached: accountSession.isBreached,
          });
        } catch (angelErr: any) {
          console.info('[AngelOne] PnL positions unavailable:', angelErr?.message || angelErr);
        }
      }

      // Angel One is not connected or positions unavailable - return stale state preserving riskSession
      const latestConnStatus = await liveAngelOneAdapter.getConnectionStatus(userId, { connectionId: accountId });
      const accountSession = await ServerRiskStore.getSession(userId, undefined, accountId);
      const preservedPnl = accountSession?.currentPnl ?? accountSession?.realisedPnl ?? 0;
      const preservedLoss = accountSession?.lossAmount ?? (preservedPnl < 0 ? Math.abs(preservedPnl) : 0);
      return sendJson(res, {
        tradingDate: getTradingDateKolkata(),
        realisedPnl: accountSession?.realisedPnl ?? preservedPnl,
        unrealisedPnl: accountSession?.unrealisedPnl ?? 0,
        totalPnl: preservedPnl,
        grossTradingPnl: preservedPnl,
        dailyRealisedPnl: accountSession?.realisedPnl ?? preservedPnl,
        dailyUnrealisedPnl: accountSession?.unrealisedPnl ?? 0,
        fnoPositionCount: 0,
        totalPositionCount: 0,
        positions: [],
        source: 'ANGELONE_DISCONNECTED' as const,
        dataSource: 'ANGELONE_DISCONNECTED' as const,
        calculatedAt: new Date().toISOString(),
        riskSession: accountSession,
        shadowSession: accountSession,
        state: accountSession?.state || 'ALLOW',
        currentPnl: preservedPnl,
        lossAmount: preservedLoss,
        dailyLossLimit: config.dailyLossLimit,
        executionMode: config.executionMode || 'ENFORCE',
        broker: 'angelone',
        connectionStatus: latestConnStatus.status,
        isStale: true,
        isUnavailable: true,
        error: 'Angel One positions unavailable',
      });
    }

    const liveAdapter = BrokerService.getLiveAdapter();
    const connStatus = await liveAdapter.getConnectionStatus(userId);

    // If Zerodha is authenticated and connected, return validated real live P&L
    if (connStatus.status === 'CONNECTED' && connStatus.authenticated) {
      const validationResult = await LivePnlValidationService.validateLivePnl(
        config,
        new Date(),
        undefined,
        undefined,
        userId
      );

      // Do not fall back to mock data if live connection is active
      if (
        validationResult.validationState !== 'AUTHENTICATION_REQUIRED' &&
        validationResult.validationState !== 'ERROR'
      ) {
        let liveRiskSession: any = null;
        let shadowRiskResult: any = null;

        const isRecordingActive = await getLiveRiskStateRecordingEnabled(userId);
        if (isRecordingActive) {
          const liveRiskResult = await LiveRiskRecorder.evaluateAndRecordLiveRisk(userId, {
            evaluationTime: new Date(),
          });
          liveRiskSession = liveRiskResult.session;
        } else {
          shadowRiskResult = await ShadowRiskService.evaluateLiveShadow(userId);
          liveRiskSession = {
            tradingDate: validationResult.tradingDate,
            userId,
            state: shadowRiskResult.expectedState,
            isBreached: shadowRiskResult.isBreached,
            lockedAt: shadowRiskResult.lockedAt || null,
            lockUntil: shadowRiskResult.lockUntil || null,
            currentPnl: validationResult.calculated.grossTradingPnl,
            lossAmount: shadowRiskResult.lossAmount,
            realisedPnl: validationResult.calculated.dailyRealisedPnl,
            unrealisedPnl: validationResult.calculated.dailyUnrealisedPnl,
            lossLimit: config.dailyLossLimit,
            warningThreshold1: config.warningThreshold1,
            warningThreshold2: config.warningThreshold2,
            lastEvaluatedAt: shadowRiskResult.evaluatedAt,
            reason: shadowRiskResult.reason,
          };
        }

        const livePnlResult = {
          tradingDate: validationResult.tradingDate,
          realisedPnl: validationResult.calculated.realisedPnl,
          unrealisedPnl: validationResult.calculated.unrealisedPnl,
          totalPnl: validationResult.calculated.grossTradingPnl,
          grossTradingPnl: validationResult.calculated.grossTradingPnl,
          dailyRealisedPnl: validationResult.calculated.dailyRealisedPnl,
          dailyUnrealisedPnl: validationResult.calculated.dailyUnrealisedPnl,
          fnoPositionCount: validationResult.calculated.fnoPositionCount,
          totalPositionCount: validationResult.calculated.fnoPositionCount,
          positions: validationResult.positions || [],
          includedRealisedPnl: validationResult.calculated.dailyRealisedPnl,
          includedUnrealisedPnl: validationResult.calculated.dailyUnrealisedPnl,
          source: 'ZERODHA_LIVE' as const,
          dataSource: 'ZERODHA_LIVE' as const,
          calculatedAt: validationResult.timestamp,
          evaluatedAt: validationResult.timestamp,
          validationState: validationResult.validationState,
          marketDataStatus: validationResult.marketDataStatus,
          riskSession: liveRiskSession,
          shadowSession: liveRiskSession,
          shadowRisk: shadowRiskResult,
          state: liveRiskSession.state,
          currentPnl: validationResult.calculated.grossTradingPnl,
          lossAmount: liveRiskSession.lossAmount,
          dailyLossLimit: config.dailyLossLimit,
          warningThresholds: {
            warningThreshold1: config.warningThreshold1,
            warningThreshold2: config.warningThreshold2,
          },
          liveRiskStateRecordingEnabled: isRecordingActive,
          recordingStatus: isRecordingActive ? 'ACTIVE' : 'SHADOW_ONLY',
        };

        return sendJson(res, livePnlResult);
      }
    }

    // Preserve existing simulation mode when live data is unavailable
    const positions = await BrokerService.getNormalizedPositions();
    let pnlResult: any;
    try {
      pnlResult = PnlEngine.calculate(positions, config);
    } catch {
      pnlResult = {
        tradingDate: getTradingDateKolkata(),
        realisedPnl: 0,
        unrealisedPnl: 0,
        totalPnl: 0,
        grossTradingPnl: 0,
        dailyRealisedPnl: 0,
        dailyUnrealisedPnl: 0,
        fnoPositionCount: positions.filter((p) => p.isFno).length,
        totalPositionCount: positions.length,
        positions: positions.filter((p) => p.isFno),
        source: 'MOCK_DATA',
        calculatedAt: new Date().toISOString(),
      };
    }
    sendJson(res, pnlResult);
  } catch (err) {
    console.error('[PnL] Calculation route error:', err);
    sendJson(res, { error: err instanceof Error ? err.message : 'Failed to calculate P&L' }, 500);
  }
});

// GET /api/pnl/live-validation - Phase 8 Live Zerodha P&L Validation & Shadow Mode
apiRouter.get('/pnl/live-validation', async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId || await authenticateRequest(req, res);
    if (!userId) return;
    const config = await ServerRiskStore.getConfig(userId);
    const validationResult = await LivePnlValidationService.validateLivePnl(
      config,
      new Date(),
      undefined,
      undefined,
      userId
    );
    sendJson(res, validationResult);
  } catch (err) {
    sendJson(res, { error: err instanceof Error ? err.message : 'Live P&L validation failed' }, 500);
  }
});

// GET /api/risk/shadow - Phase 9 Live P&L → Risk Engine Shadow Integration
apiRouter.get('/risk/shadow', async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId || await authenticateRequest(req, res);
    if (!userId) return;
    const shadowResult = await ShadowRiskService.evaluateLiveShadow(userId);
    sendJson(res, shadowResult);
  } catch (err) {
    sendJson(res, { error: err instanceof Error ? err.message : 'Live risk shadow evaluation failed' }, 500);
  }
});

// GET /api/risk/recording-status - Phase 10B Controlled Live Risk Diagnostic & Status Information
const handleRecordingStatus = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId || await authenticateRequest(req, res);
    if (!userId) return;
    const enabled = await getLiveRiskStateRecordingEnabled(userId);
    const session = await ServerRiskStore.getSession(userId);
    const liveAdapter = BrokerService.getLiveAdapter();
    const connStatus = await liveAdapter.getConnectionStatus(userId);
    const dataSource = (connStatus.status === 'CONNECTED' && connStatus.authenticated)
      ? 'ZERODHA_LIVE'
      : 'MOCK_DATA';
    const tradingDate = session?.tradingDate || getTradingDateKolkata();

    sendJson(res, {
      enabled,
      liveRiskStateRecordingEnabled: enabled,
      activationState: enabled ? 'ACTIVE' : 'SHADOW_ONLY',
      currentRiskState: session?.state || 'ALLOW',
      tradingDate,
      lockUntil: session?.lockUntil || null,
      dataSource,
      status: enabled ? 'RECORDING_ENABLED' : 'SHADOW_ONLY',
      message: enabled
        ? 'Authoritative live RiskSession/riskEvents recording is active.'
        : 'Authoritative live RiskSession/riskEvents recording is disabled (Strict Shadow Mode).',
    });
  } catch (err) {
    sendJson(res, { error: err instanceof Error ? err.message : 'Failed to retrieve recording status' }, 500);
  }
};

apiRouter.get('/risk/recording-status', handleRecordingStatus);
apiRouter.get('/risk/live/recording', handleRecordingStatus);
apiRouter.get('/risk/live/recording/status', handleRecordingStatus);

// GET /api/risk/live/activation/preflight - Phase 11A Server-Authoritative Production Preflight Check
const handleActivationPreflight = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId || await authenticateRequest(req, res);
    if (!userId) return;
    const preflight = await ActivationGuardService.evaluatePreflight(userId);
    sendJson(res, preflight);
  } catch (err) {
    sendJson(res, { error: err instanceof Error ? err.message : 'Preflight evaluation failed' }, 500);
  }
};

apiRouter.get('/risk/live/activation/preflight', handleActivationPreflight);
apiRouter.get('/risk/recording/preflight', handleActivationPreflight);

// POST /api/risk/recording/control - Phase 10B/11A Server-Authoritative Controlled Activation
const handleRecordingControl = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId || await authenticateRequest(req, res);
    if (!userId) return;
    const { enabled } = req.body || {};
    if (typeof enabled !== 'boolean') {
      return sendJson(res, { error: 'INVALID_REQUEST', message: '"enabled" boolean field is required' }, 400);
    }

    if (enabled) {
      // Evaluate server-authoritative preflight checks BEFORE permitting activation
      const preflight = await ActivationGuardService.evaluatePreflight(userId);
      if (!preflight.ready || preflight.blockers.length > 0) {
        return sendJson(
          res,
          {
            success: false,
            error: 'PREFLIGHT_CHECK_FAILED',
            message: 'Cannot enable live risk state recording: preflight checks failed.',
            preflight,
            blockers: preflight.blockers,
          },
          400
        );
      }

      try {
        await setLiveRiskStateRecordingEnabled(true, userId);
      } catch (err) {
        return sendJson(
          res,
          {
            success: false,
            error: 'RECORDING_STATE_PERSISTENCE_FAILED',
            message: `Authoritative live risk recording persistence failed: ${err instanceof Error ? err.message : 'Storage failure'}`,
          },
          500
        );
      }

      ServerRiskStore.recordEvent(userId, {
        type: 'CONFIG_UPDATED',
        message: `Authoritative live RiskSession recording explicitly activated for user ${userId}.`,
      });

      // Perform FIRST REAL EVALUATION immediately after activation
      const firstEvaluation = await LiveRiskRecorder.evaluateAndRecordLiveRisk(userId);

      sendJson(res, {
        success: true,
        enabled: true,
        liveRiskStateRecordingEnabled: true,
        activationState: 'ACTIVE',
        currentRiskState: firstEvaluation.state || preflight.currentRiskState,
        tradingDate: firstEvaluation.tradingDate || preflight.tradingDate,
        lockUntil: firstEvaluation.session?.lockUntil || preflight.lockUntil,
        lossAmount: firstEvaluation.lossAmount ?? 0,
        grossTradingPnl: firstEvaluation.grossTradingPnl ?? 0,
        dataSource: firstEvaluation.dataSource || preflight.dataSource,
        status: 'RECORDING_ENABLED',
        message: 'Authoritative live RiskSession/riskEvents recording activated and first real evaluation completed.',
        firstEvaluation,
      });
    } else {
      try {
        await setLiveRiskStateRecordingEnabled(false, userId);
      } catch (err) {
        return sendJson(
          res,
          {
            success: false,
            error: 'RECORDING_STATE_PERSISTENCE_FAILED',
            message: `Authoritative live risk recording deactivation persistence failed: ${err instanceof Error ? err.message : 'Storage failure'}`,
          },
          500
        );
      }

      ServerRiskStore.recordEvent(userId, {
        type: 'CONFIG_UPDATED',
        message: `Authoritative live RiskSession recording explicitly deactivated (Shadow Mode) for user ${userId}.`,
      });

      sendJson(res, {
        success: true,
        enabled: false,
        liveRiskStateRecordingEnabled: false,
        activationState: 'SHADOW_ONLY',
        status: 'SHADOW_ONLY',
        message: 'Authoritative live RiskSession/riskEvents recording deactivated (Shadow Mode).',
      });
    }
  } catch (err) {
    sendJson(res, { error: err instanceof Error ? err.message : 'Failed to update recording control' }, 500);
  }
};

apiRouter.post('/risk/recording/control', handleRecordingControl);
apiRouter.post('/risk/live/recording', handleRecordingControl);

// GET /api/risk - Authoritative Risk Session
apiRouter.get('/risk', async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId || await authenticateRequest(req, res);
    if (!userId) return;
    const accountId = (req.query?.accountId as string) || (req.headers['x-account-id'] as string) || undefined;

    // Isolated Simulation Check: Serve active simulation session if active
    const simSession = await ServerRiskStore.getSimulatedSession(userId, accountId);
    if (simSession && simSession.isSimulated === true) {
      return sendJson(res, simSession);
    }

    if (!(await getLiveRiskStateRecordingEnabled(userId))) {
      const liveAdapter = BrokerService.getLiveAdapter();
      const connStatus = await liveAdapter.getConnectionStatus(userId);
      if (connStatus.status === 'CONNECTED' && connStatus.authenticated) {
        let testEvalTime: Date | undefined = undefined;
        const isProduction = process.env.NODE_ENV === 'production';
        const isRunningInTest = typeof process !== 'undefined' && (
          process.env.NODE_ENV === 'test' ||
          process.argv.some(arg => arg.includes('test'))
        );

        if (isRunningInTest && !isProduction) {
          const headerVal = req.headers['x-test-evaluation-time'];
          if (typeof headerVal === 'string' && headerVal.trim().length > 0) {
            const parsed = new Date(headerVal);
            if (!isNaN(parsed.getTime())) {
              testEvalTime = parsed;
            }
          }
        }

        const shadowResult = await ShadowRiskService.evaluateLiveShadow(userId, {
          evaluationTime: testEvalTime,
        });
        const config = await ServerRiskStore.getConfig(userId, accountId);
        return sendJson(res, {
          tradingDate: shadowResult.tradingDate,
          userId,
          state: shadowResult.expectedState,
          isBreached: shadowResult.isBreached,
          lockedAt: shadowResult.lockedAt || null,
          lockUntil: shadowResult.lockUntil || null,
          currentPnl: shadowResult.grossTradingPnl,
          lossAmount: shadowResult.lossAmount,
          realisedPnl: shadowResult.pnlResult?.dailyRealisedPnl ?? 0,
          unrealisedPnl: shadowResult.pnlResult?.dailyUnrealisedPnl ?? 0,
          lossLimit: config.dailyLossLimit,
          warningThreshold1: config.warningThreshold1,
          warningThreshold2: config.warningThreshold2,
          lastEvaluatedAt: shadowResult.evaluatedAt,
          reason: shadowResult.reason,
          shadow: true,
        });
      }
    }
    const session = await ServerRiskStore.getSession(userId, undefined, accountId);
    sendJson(res, session);
  } catch (err) {
    sendJson(res, { error: err instanceof Error ? err.message : 'Failed to fetch risk session' }, 500);
  }
});

// GET /api/risk/config - Current Risk Configuration
apiRouter.get('/risk/config', async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId || await authenticateRequest(req, res);
    if (!userId) return;
    const accountId = (req.query?.accountId as string) || (req.headers['x-account-id'] as string) || undefined;
    const config = await ServerRiskStore.getConfig(userId, accountId);
    sendJson(res, config);
  } catch (err) {
    sendJson(res, { error: err instanceof Error ? err.message : 'Failed to fetch risk config' }, 500);
  }
});

// PUT /api/risk/config - Server-Validated Risk Configuration Update
apiRouter.put('/risk/config', async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId || await authenticateRequest(req, res);
    if (!userId) return;
    const body = req.body;
    const accountId = (req.query?.accountId as string) || (req.body?.accountId as string) || (req.headers['x-account-id'] as string) || undefined;
    const result = await ServerRiskStore.saveConfig(userId, body, accountId);

    if (!result.success) {
      const isLocked = result.code === 'RISK_CONFIG_LOCKED' || result.errors?.some(e => e.includes('RISK_CONFIG_LOCKED'));
      return sendJson(
        res,
        {
          success: false,
          code: isLocked ? 'RISK_CONFIG_LOCKED' : 'INVALID_CONFIG',
          errors: result.errors,
        },
        isLocked ? 403 : 400
      );
    }

    sendJson(res, { success: true, config: result.config });
  } catch (err) {
    sendJson(res, { success: false, errors: [err instanceof Error ? err.message : 'Server error updating config'] }, 500);
  }
});

// GET /api/lock/status & /api/risk/lock-status - Authoritative Lock State
const getLockStatusHandler = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId || await authenticateRequest(req, res);
    if (!userId) return;
    const rawAccountId = (req.query?.accountId as string) || (req.headers['x-account-id'] as string) || undefined;
    const accountId = typeof rawAccountId === 'string' && rawAccountId.trim().length > 0 ? rawAccountId.trim() : undefined;
    const status = await ServerRiskStore.getLockStatus(userId, accountId);
    sendJson(res, { ...status, authority: 'server' });
  } catch (err) {
    sendJson(res, { error: err instanceof Error ? err.message : 'Failed to fetch lock status' }, 500);
  }
};
apiRouter.get('/lock/status', getLockStatusHandler);
apiRouter.get('/risk/lock-status', getLockStatusHandler);

// GET /api/enforcement/status - Phase 6 Authoritative Enforcement State
apiRouter.get('/enforcement/status', async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId || await authenticateRequest(req, res);
    if (!userId) return;
    const rawAccountId = (req.query?.accountId as string) || (req.headers['x-account-id'] as string) || undefined;
    const accountId = typeof rawAccountId === 'string' && rawAccountId.trim().length > 0 ? rawAccountId.trim() : undefined;
    const state = await EnforcementService.getEnforcementState(userId, undefined, accountId);
    sendJson(res, state);
  } catch (err) {
    sendJson(res, { error: err instanceof Error ? err.message : 'Failed to retrieve enforcement state' }, 500);
  }
});

// GET /api/risk/extension-token - Secure extension token retrieval
apiRouter.get('/risk/extension-token', async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId || await authenticateRequest(req, res);
    if (!userId) return;

    const token = generateExtensionToken(userId);
    sendJson(res, { userId, extensionToken: token });
  } catch (err) {
    sendJson(res, { error: err instanceof Error ? err.message : 'Failed to generate extension token' }, 500);
  }
});

// GET /api/enforcement/broker - Phase 12B Server-Authoritative Broker Enforcement Contract
apiRouter.get('/enforcement/broker', async (req: Request, res: Response) => {
  try {
    const userId = req.headers['x-user-id'] as string;
    const extensionToken = req.headers['x-extension-token'] as string;

    // Independent cryptographic verification of the extension token
    if (!userId || !extensionToken || !verifyExtensionToken(userId, extensionToken)) {
      return sendJson(res, { error: 'UNAUTHORIZED_EXTENSION', message: 'Invalid or missing extension token' }, 401);
    }

    const contract = await EnforcementService.getBrokerEnforcementContract(userId);
    sendJson(res, contract);
  } catch (err) {
    sendJson(res, { error: err instanceof Error ? err.message : 'Failed to retrieve broker enforcement contract' }, 500);
  }
});

// GET /api/protected/trading - Phase 6 Protected Trading Endpoint Guarded by Trading Firewall
apiRouter.get('/protected/trading', requireTradingAccess, (req: Request, res: Response) => {
  const enforcementState = (req as any).enforcementState;
  sendJson(res, {
    status: 'AUTHORIZED',
    message: 'Protected trading operation authorized by Trading Firewall.',
    riskState: enforcementState?.riskState || 'ALLOW',
    authority: 'server',
    timestamp: new Date().toISOString(),
  });
});

// POST /api/risk/evaluate - Phase 5 Authoritative Risk Evaluation
apiRouter.post('/risk/evaluate', async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId || await authenticateRequest(req, res);
    if (!userId) return;

    const accountId = (req.query?.accountId as string) || (req.body?.accountId as string) || (req.headers['x-account-id'] as string) || undefined;
    const evalDate = req.body?.evaluationTime ? new Date(req.body.evaluationTime) : new Date();

    const isSandboxUser = userId === 'mock-trader-sandbox' || userId.startsWith('mock-');
    const isTestEnvironment = process.env.NODE_ENV !== 'production' && typeof process !== 'undefined' && (
      process.env.NODE_ENV === 'test' ||
      process.argv.some(arg => arg.includes('test'))
    );

    // If demo reset is requested:
    if (req.body?.reset === true) {
      const resetSession = await ServerRiskStore.resetSimulatedSession(userId, accountId);
      return sendJson(res, {
        success: true,
        state: resetSession.state,
        currentPnl: resetSession.currentPnl,
        session: resetSession,
        message: 'Demo state reset to baseline',
      });
    }

    // If developer testing panel passes simulated pnl input:
    if (req.body?.pnl !== undefined) {
      if (typeof req.body.pnl !== 'number' || isNaN(req.body.pnl)) {
        return sendJson(res, { error: 'Valid numeric pnl is required for simulation' }, 400);
      }
      const result = await ServerRiskStore.evaluateSimulatedPnl(userId, req.body.pnl, evalDate, accountId);
      return sendJson(res, result);
    }

    // Phase 5 Authoritative Pipeline: Server loads positions, runs PnlEngine, and evaluates RiskEngine
    const result = await ServerRiskStore.evaluateFromPositions(userId, evalDate, accountId);
    sendJson(res, result);
  } catch (err) {
    sendJson(res, { error: err instanceof Error ? err.message : 'Evaluation failed' }, 500);
  }
});

// GET /api/risk/events - Transition Audit Trail & Activity Events
apiRouter.get('/risk/events', async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId || await authenticateRequest(req, res);
    if (!userId) return;

    const accountId = (req.query?.accountId as string) || (req.headers['x-account-id'] as string) || undefined;
    const limit = Math.min(100, Math.max(1, parseInt(req.query?.limit as string || '50', 10) || 50));

    const events = await ServerRiskStore.getAuditEvents(userId, accountId, limit);
    const persistenceDegraded = ServerRiskStore.getIsPersistenceDegraded();
    const bufferedCount = ServerRiskStore.getBufferedEventsCount();
    sendJson(res, { events, count: events.length, accountId, persistenceDegraded, bufferedCount });
  } catch (err) {
    console.error('[RiskEvents] Fetch route error:', err);
    sendJson(res, { error: err instanceof Error ? err.message : 'Failed to fetch risk events' }, 500);
  }
});

// ============================================================================
// PHASE 8A — CONTROLLED REAL-ACCOUNT SHADOW VALIDATION SESSION ENDPOINTS
// ============================================================================

// POST /api/validation/session/start - Start validation session
apiRouter.post('/validation/session/start', async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId || await authenticateRequest(req, res);
    if (!userId) return;
    const notes = req.body?.notes;
    const session = ValidationSessionManager.startSession(userId, notes);
    sendJson(res, { success: true, session });
  } catch (err) {
    sendJson(res, { error: err instanceof Error ? err.message : 'Failed to start validation session' }, 500);
  }
});

// GET /api/validation/session/active - Get current active validation session
apiRouter.get('/validation/session/active', async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId || await authenticateRequest(req, res);
    if (!userId) return;
    const session = ValidationSessionManager.getActiveSession(userId);
    sendJson(res, { active: !!session, session });
  } catch (err) {
    sendJson(res, { error: err instanceof Error ? err.message : 'Failed to fetch active session' }, 500);
  }
});

// POST /api/validation/session/capture - Capture raw positions snapshot and record observations
apiRouter.post('/validation/session/capture', async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId || await authenticateRequest(req, res);
    if (!userId) return;

    let session = ValidationSessionManager.getActiveSession(userId);
    if (!session) {
      session = ValidationSessionManager.startSession(userId, 'Auto-started for capture');
    }

    const liveAdapter = BrokerService.getLiveAdapter();
    const conn = await liveAdapter.getConnectionStatus(userId);

    if (conn.status !== 'CONNECTED') {
      return sendJson(res, {
        success: false,
        status: conn.status,
        message: `Live Zerodha connection inactive: ${conn.message}`,
        session,
        observations: [],
      });
    }

    const rawPositions = await liveAdapter.getPositions(userId);
    let liveInstruments: any[] = [];
    try {
      liveInstruments = await liveAdapter.getInstruments(userId);
    } catch {
      liveInstruments = [];
    }
    const instrumentMap = new Map(liveInstruments.map((i) => [i.instrumentToken, i]));

    const config = await ServerRiskStore.getConfig(userId);
    const validationResult = await LivePnlValidationService.validateLivePnl(
      config,
      new Date(),
      undefined,
      undefined,
      userId
    );

    const observations = rawPositions.map((raw) => {
      const inst = instrumentMap.get(raw.instrument_token);
      const isFno = !!(inst && ['NFO-FUT', 'NFO-OPT', 'BFO-FUT', 'BFO-OPT'].includes(inst.segment));
      return ValidationSessionManager.recordObservation(
        session!.validationSessionId,
        raw,
        isFno,
        inst,
        validationResult.calculated ? {
          dailyRealised: validationResult.calculated.dailyRealisedPnl,
          dailyUnrealised: validationResult.calculated.dailyUnrealisedPnl,
          grossTradingPnl: validationResult.calculated.grossTradingPnl,
        } : undefined,
        undefined,
        userId
      );
    });

    sendJson(res, {
      success: true,
      session,
      count: observations.length,
      observations,
      validationResult,
    });
  } catch (err) {
    sendJson(res, { error: err instanceof Error ? err.message : 'Failed to capture observation' }, 500);
  }
});

// POST /api/validation/session/end - Conclude active validation session and generate report
apiRouter.post('/validation/session/end', async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId || await authenticateRequest(req, res);
    if (!userId) return;

    const active = ValidationSessionManager.getActiveSession(userId);
    if (!active) {
      return sendJson(res, { error: 'No active validation session to end' }, 400);
    }
    const ended = ValidationSessionManager.endSession(userId, active.validationSessionId);
    const report = ValidationSessionManager.generateReport(active.validationSessionId, undefined, userId);
    sendJson(res, { success: true, endedSession: ended, report });
  } catch (err) {
    sendJson(res, { error: err instanceof Error ? err.message : 'Failed to end session' }, 500);
  }
});

// GET /api/validation/session/report - Generate report for active or requested session
const handleValidationReport = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId || await authenticateRequest(req, res);
    if (!userId) return;

    const requestedSessionId = (req.query.sessionId as string) || (req.query.validationSessionId as string);
    const active = ValidationSessionManager.getActiveSession(userId);
    const sessionId = requestedSessionId || active?.validationSessionId;

    if (!sessionId) {
      return sendJson(res, { error: 'No active or requested sessionId' }, 404);
    }

    let report: any;
    try {
      report = ValidationSessionManager.generateReport(sessionId, undefined, userId);
    } catch (reportErr: any) {
      if (reportErr?.message?.includes('Unauthorized')) {
        return sendJson(res, { error: 'Validation session not found or access denied' }, 404);
      }
      throw reportErr;
    }
    if (!report) {
      return sendJson(res, { error: 'Validation session not found or access denied' }, 404);
    }
    sendJson(res, report);
  } catch (err) {
    sendJson(res, { error: err instanceof Error ? err.message : 'Failed to generate report' }, 500);
  }
};

apiRouter.get('/validation/session/report', handleValidationReport);
apiRouter.get('/api/validation/session/report', handleValidationReport);

export default apiRouter;
