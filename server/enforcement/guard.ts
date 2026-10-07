import { Request, Response, NextFunction } from 'express';
import { EnforcementService } from './service';
import crypto from 'crypto';
import { authenticateRequest } from '../auth/session';

/**
 * Generates a stateless, server-authoritative pairing token for the extension based on userId.
 * Employs a stable server-side secret (from ZERODHA_API_SECRET) to prevent fabrication.
 */
export function generateExtensionToken(userId: string): string {
  const secret = process.env.ZERODHA_API_SECRET || 'fallback_secret_for_development';
  return crypto.createHmac('sha256', secret).update(userId).digest('hex');
}

/**
 * Validates the extension's pairing token cryptographically using timing-safe comparison.
 */
export function verifyExtensionToken(userId: string, token: string): boolean {
  if (!userId || !token) return false;
  const expected = generateExtensionToken(userId);
  try {
    return crypto.timingSafeEqual(Buffer.from(token, 'hex'), Buffer.from(expected, 'hex'));
  } catch {
    return false;
  }
}

/**
 * Verifies that the client calling /api/risk/extension-token is actually authorized
 * for targetUserId (implements the secure binding check to prevent impersonation).
 */
export async function isRequestAuthorizedForUser(
  req: Request,
  targetUserId: string
): Promise<boolean> {
  if (!targetUserId) return false;
  const uid = await authenticateRequest(req);
  return uid === targetUserId;
}

/**
 * Express Middleware: requireTradingAccess
 *
 * Enforces server-authoritative Trading Firewall access before executing protected operations.
 * - HTTP 401: Unauthenticated request
 * - HTTP 423: Locked by Trading Firewall circuit breaker
 * - HTTP 500: Fail-closed on authorization errors
 */
export async function requireTradingAccess(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const userId = (req as any).userId || await authenticateRequest(req, res);
  if (!userId) return;

  const decision = await EnforcementService.checkTradingAccess(userId);

  if (!decision.allowed) {
    res.status(decision.statusCode).json({
      error: decision.error,
      message: decision.message,
      lockUntil: decision.state?.lockUntil || null,
      riskState: decision.state?.riskState || null,
      authority: 'server',
      timestamp: new Date().toISOString(),
    });
    return;
  }

  // Attach verified enforcement state to request context
  (req as any).enforcementState = decision.state;
  next();
}

