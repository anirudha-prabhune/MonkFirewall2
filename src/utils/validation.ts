import { RiskConfig, DEFAULT_RISK_CONFIG } from '../types/risk';

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  sanitized?: RiskConfig;
}

/**
 * Deterministic Risk Configuration Validator.
 */
export function validateRiskConfig(input: any): ValidationResult {
  const errors: string[] = [];

  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { valid: false, errors: ['Configuration payload must be an object'] };
  }

  // Check for forbidden server-authoritative fields in client payload
  const forbiddenFields = [
    'state',
    'isBreached',
    'lockedAt',
    'lockUntil',
    'lockExpiresAt',
    'breachReason',
    'reason',
    'currentPnl',
    'lossUtilizedPercent',
    'tradingDate',
    'lastEvaluatedAt',
  ];

  for (const field of forbiddenFields) {
    if (field in input) {
      errors.push(`Client cannot supply server-authoritative field: '${field}'`);
    }
  }

  // 1. dailyLossLimit: minimum ₹500, increments of ₹500, no negative, no ₹0
  const rawLimit = input.dailyLossLimit;
  if (rawLimit === undefined || rawLimit === null) {
    errors.push('dailyLossLimit is required');
  } else if (typeof rawLimit !== 'number' || isNaN(rawLimit) || !isFinite(rawLimit)) {
    errors.push('dailyLossLimit must be a finite valid number');
  } else if (rawLimit <= 0) {
    errors.push('dailyLossLimit must be greater than 0 (minimum ₹500, ₹0 is not allowed)');
  } else if (rawLimit < 500) {
    errors.push('dailyLossLimit must be at least ₹500');
  } else if (rawLimit % 500 !== 0) {
    errors.push('dailyLossLimit must be in increments of ₹500');
  }

  // 2. warningThreshold1
  const rawT1 = input.warningThreshold1;
  if (rawT1 === undefined || rawT1 === null) {
    errors.push('warningThreshold1 is required');
  } else if (typeof rawT1 !== 'number' || isNaN(rawT1) || !isFinite(rawT1)) {
    errors.push('warningThreshold1 must be a finite valid percentage number');
  } else if (rawT1 <= 0) {
    errors.push('warningThreshold1 must be greater than 0%');
  } else if (rawT1 >= 100) {
    errors.push('warningThreshold1 must be strictly less than 100%');
  }

  // 3. warningThreshold2
  const rawT2 = input.warningThreshold2;
  if (rawT2 === undefined || rawT2 === null) {
    errors.push('warningThreshold2 is required');
  } else if (typeof rawT2 !== 'number' || isNaN(rawT2) || !isFinite(rawT2)) {
    errors.push('warningThreshold2 must be a finite valid percentage number');
  } else if (rawT2 <= 0) {
    errors.push('warningThreshold2 must be greater than 0%');
  } else if (rawT2 > 100) {
    errors.push('warningThreshold2 cannot exceed 100%');
  }

  // Ordering check: warningThreshold2 must be greater than warningThreshold1
  if (typeof rawT1 === 'number' && typeof rawT2 === 'number' && !isNaN(rawT1) && !isNaN(rawT2)) {
    if (rawT2 <= rawT1) {
      errors.push(`warningThreshold2 (${rawT2}%) must be strictly greater than warningThreshold1 (${rawT1}%)`);
    }
  }

  // 4. lockDurationMinutes
  const rawDuration = input.lockDurationMinutes;
  if (rawDuration === undefined || rawDuration === null) {
    errors.push('lockDurationMinutes is required for Fixed Duration');
  } else if (typeof rawDuration !== 'number' || isNaN(rawDuration) || !isFinite(rawDuration)) {
    errors.push('lockDurationMinutes must be a finite valid number');
  } else if (rawDuration <= 0) {
    errors.push('lockDurationMinutes must be greater than 0');
  }

  // 5. lockDurationType
  const rawType = input.lockDurationType;
  if (rawType !== undefined && rawType !== null) {
    if (rawType !== 'FIXED' && rawType !== 'UNTIL_4PM') {
      errors.push("lockDurationType must be either 'FIXED' or 'UNTIL_4PM'");
    }
  }

  // 6. Boolean fields
  if (input.includeRealisedPnl !== undefined && typeof input.includeRealisedPnl !== 'boolean') {
    errors.push('includeRealisedPnl must be a boolean');
  }
  if (input.includeUnrealisedPnl !== undefined && typeof input.includeUnrealisedPnl !== 'boolean') {
    errors.push('includeUnrealisedPnl must be a boolean');
  }
  if (input.enabled !== undefined && typeof input.enabled !== 'boolean') {
    errors.push('enabled must be a boolean');
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  const sanitized: RiskConfig = {
    dailyLossLimit: Number(rawLimit),
    warningThreshold1: Number(rawT1),
    warningThreshold2: Number(rawT2),
    lockDurationMinutes: Number(rawDuration !== undefined ? rawDuration : DEFAULT_RISK_CONFIG.lockDurationMinutes),
    lockDurationType: rawType || DEFAULT_RISK_CONFIG.lockDurationType || 'FIXED',
    includeRealisedPnl: input.includeRealisedPnl !== undefined ? Boolean(input.includeRealisedPnl) : DEFAULT_RISK_CONFIG.includeRealisedPnl,
    includeUnrealisedPnl: input.includeUnrealisedPnl !== undefined ? Boolean(input.includeUnrealisedPnl) : DEFAULT_RISK_CONFIG.includeUnrealisedPnl,
    enabled: input.enabled !== undefined ? Boolean(input.enabled) : DEFAULT_RISK_CONFIG.enabled,
    updatedAt: new Date().toISOString(),
  };

  return { valid: true, errors: [], sanitized };
}
