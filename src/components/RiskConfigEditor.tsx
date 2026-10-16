import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  Sliders,
  Save,
  CheckCircle,
  AlertCircle,
  RefreshCw,
  AlertTriangle,
  ShieldCheck,
  Clock,
  TrendingDown,
  Bell,
  Calculator,
  Building2,
  Eye,
  ShieldAlert,
} from 'lucide-react';
import { RiskConfig, DEFAULT_ACCOUNT_ID, DEFAULT_ANGELONE_ACCOUNT_ID } from '../types/risk';
import { getRiskConfig, saveRiskConfig } from '../services/riskConfigService';
import { getBrokerConnections } from '../services/brokerConnectionService';
import { BrokerConnection } from '../types/broker';
import { useAuth } from '../context/AuthContext';
import { formatINR, getFriendlyAccountLabel } from '../utils/formatters';
import { validateRiskConfig } from '../utils/validation';
import { subscribeRiskSession } from '../services/riskSessionService';

export interface RiskConfigEditorProps {
  initialConfig: RiskConfig;
  onSaved: (newConfig: RiskConfig) => void;
  isLocked?: boolean;
  accountId?: string;
  onSelectAccount?: (newAccountId: string) => void;
  availableAccounts?: Array<{ connectionId: string; connection: BrokerConnection }>;
}

export const RiskConfigEditor: React.FC<RiskConfigEditorProps> = ({
  initialConfig,
  onSaved,
  isLocked = false,
  accountId: accountIdProp,
  onSelectAccount,
  availableAccounts: accountsProp,
}) => {
  const { user } = useAuth();

  // Internal account state if not controlled from parent
  const [internalAccountId, setInternalAccountId] = useState<string>(
    accountIdProp || initialConfig.accountId || DEFAULT_ACCOUNT_ID
  );
  const activeAccountId = accountIdProp || internalAccountId;

  const [connectedAccounts, setConnectedAccounts] = useState<
    Array<{ connectionId: string; connection: BrokerConnection }>
  >(accountsProp || []);
  const [loadingAccounts, setLoadingAccounts] = useState<boolean>(!accountsProp || accountsProp.length === 0);

  const [formData, setFormData] = useState<RiskConfig>({ ...initialConfig });
  const [loadingConfig, setLoadingConfig] = useState<boolean>(false);
  const [saving, setSaving] = useState<boolean>(false);
  const [verifying, setVerifying] = useState<boolean>(false);
  const [message, setMessage] = useState<{ text: string; type: 'success' | 'error' } | null>(null);
  const [validationErrors, setValidationErrors] = useState<string[]>([]);
  const [accountLocked, setAccountLocked] = useState<boolean>(false);
  const effectiveIsLocked = isLocked || accountLocked;

  useEffect(() => {
    if (!user) return;
    const unsubSession = subscribeRiskSession(
      user.uid,
      (session) => {
        setAccountLocked(session.state === 'LOCKED');
      },
      activeAccountId
    );
    return () => {
      unsubSession();
    };
  }, [user, activeAccountId]);

  // Request sequencing reference to prevent race conditions on rapid account switching
  const loadSeqRef = useRef<number>(0);
  const activeAccountIdRef = useRef<string>(activeAccountId);
  activeAccountIdRef.current = activeAccountId;

  // Determine broker type from accountId or connections
  const isAngelOne =
    activeAccountId === DEFAULT_ANGELONE_ACCOUNT_ID ||
    activeAccountId.includes('angelone') ||
    formData.broker === 'angelone';
  const brokerName = isAngelOne ? 'Angel One' : 'Zerodha';
  const executionMode = formData.executionMode || (isAngelOne ? 'OBSERVE_ONLY' : 'ENFORCE');

  // Load connected accounts if not provided as props
  useEffect(() => {
    if (accountsProp && accountsProp.length > 0) {
      setConnectedAccounts(accountsProp);
      setLoadingAccounts(false);
      return;
    }
    if (!user) return;

    let isMounted = true;
    setLoadingAccounts(true);
    getBrokerConnections(user.uid)
      .then((accs) => {
        if (!isMounted) return;
        setConnectedAccounts(accs);
      })
      .catch((err) => {
        console.warn('Failed to load broker connections in RiskConfigEditor:', err);
      })
      .finally(() => {
        if (isMounted) setLoadingAccounts(false);
      });

    return () => {
      isMounted = false;
    };
  }, [user, accountsProp]);

  // Synchronize internalAccountId when accountIdProp changes
  useEffect(() => {
    if (accountIdProp && accountIdProp !== internalAccountId) {
      setInternalAccountId(accountIdProp);
    }
  }, [accountIdProp, internalAccountId]);

  // Load authoritative risk configuration for the selected account
  const loadAccountConfig = useCallback(
    async (targetAccountId: string) => {
      if (!user) return;
      const currentSeq = ++loadSeqRef.current;
      setLoadingConfig(true);
      setMessage(null);
      setValidationErrors([]);

      try {
        const loaded = await getRiskConfig(user.uid, targetAccountId);
        if (loadSeqRef.current === currentSeq) {
          setFormData({
            ...loaded,
            accountId: targetAccountId,
            broker: (targetAccountId === DEFAULT_ANGELONE_ACCOUNT_ID || targetAccountId.includes('angelone'))
              ? 'angelone'
              : 'zerodha',
            executionMode: (targetAccountId === DEFAULT_ANGELONE_ACCOUNT_ID || targetAccountId.includes('angelone'))
              ? 'OBSERVE_ONLY'
              : (loaded.executionMode || 'ENFORCE'),
          });
        }
      } catch (err) {
        if (loadSeqRef.current === currentSeq) {
          console.error(`Failed to load risk configuration for account ${targetAccountId}:`, err);
          setMessage({
            type: 'error',
            text: `Failed to reload configuration for ${targetAccountId}: ${
              err instanceof Error ? err.message : 'Unknown error'
            }`,
          });
        }
      } finally {
        if (loadSeqRef.current === currentSeq) {
          setLoadingConfig(false);
        }
      }
    },
    [user]
  );

  // Trigger config load on account switch or initial mount
  useEffect(() => {
    loadAccountConfig(activeAccountId);
  }, [activeAccountId, loadAccountConfig]);

  // Handle switching trading account in the editor
  const handleAccountSwitch = (newAccountId: string) => {
    if (newAccountId === activeAccountId) return;
    setInternalAccountId(newAccountId);
    if (onSelectAccount) {
      onSelectAccount(newAccountId);
    }
  };

  const handleChange = (field: keyof RiskConfig, value: any) => {
    setFormData((prev) => ({
      ...prev,
      [field]: value,
    }));
    setMessage(null);
    setValidationErrors([]);
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) return;

    if (effectiveIsLocked) {
      setMessage({
        text: 'Daily Loss Limit cannot be modified while Trading Firewall circuit breaker is LOCKED.',
        type: 'error',
      });
      return;
    }

    // Validate parameters before submission
    const validation = validateRiskConfig(formData);
    if (!validation.valid) {
      setValidationErrors(validation.errors);
      setMessage({
        text: 'Please correct the validation errors below before saving.',
        type: 'error',
      });
      return;
    }

    const targetAccountId = activeAccountIdRef.current;
    setSaving(true);
    setVerifying(false);
    setValidationErrors([]);
    setMessage(null);

    try {
      // 1. Save configuration to authoritative store via authenticated API
      const payload: Partial<RiskConfig> = {
        ...formData,
        accountId: targetAccountId,
        broker: isAngelOne ? 'angelone' : 'zerodha',
        executionMode: formData.executionMode || (isAngelOne ? 'OBSERVE_ONLY' : 'ENFORCE'),
      };

      const saved = await saveRiskConfig(user.uid, payload, targetAccountId);

      // 2. Perform authoritative verification fetch to guarantee persistence
      setVerifying(true);
      const verified = await getRiskConfig(user.uid, targetAccountId);

      // Verify that critical parameters match
      if (verified.dailyLossLimit !== formData.dailyLossLimit) {
        throw new Error(
          `Persistence verification mismatch: expected ₹${formData.dailyLossLimit}, stored ₹${verified.dailyLossLimit}`
        );
      }

      // 3. Update form data with verified config and notify parent
      setFormData(verified);
      onSaved(verified);

      setMessage({
        text: `Risk parameters saved and verified for ${brokerName} (${targetAccountId}). Daily Loss Limit: ${formatINR(
          verified.dailyLossLimit
        )}.`,
        type: 'success',
      });
    } catch (err) {
      console.error('Failed to save risk configuration:', err);
      setMessage({
        text: err instanceof Error ? err.message : 'Failed to update risk parameters',
        type: 'error',
      });
    } finally {
      setSaving(false);
      setVerifying(false);
    }
  };

  // Convert minutes to hours for the UI
  const lockHours = Math.max(1, Math.round((formData.lockDurationMinutes || 60) / 60));

  const handleHoursChange = (hours: number) => {
    const safeHours = Math.max(1, Math.round(hours));
    handleChange('lockDurationMinutes', safeHours * 60);
  };

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      {/* Information Header & Account Identification */}
      <div className="bg-white dark:bg-[#1F2633] border border-[#98C1D9]/40 dark:border-[#3D4A5E] rounded-2xl p-5 text-xs text-[#293241] dark:text-[#E0FBFC] shadow-xs transition-colors duration-200">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="flex items-start space-x-3.5">
            <div className="p-2.5 rounded-xl bg-slate-100 dark:bg-[#283244] text-[#3D5A80] dark:text-[#98C1D9] border border-[#98C1D9]/40 dark:border-[#3D4A5E] shrink-0 mt-0.5">
              <ShieldCheck className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center space-x-2">
                <h3 className="font-bold text-[#293241] dark:text-[#E0FBFC] text-sm">
                  Trading Firewall Configuration
                </h3>
                {loadingConfig && (
                  <RefreshCw className="w-3.5 h-3.5 animate-spin text-[#EE6C4D]" />
                )}
              </div>
              <p className="text-[#5C6B7E] dark:text-[#98C1D9] mt-0.5 leading-relaxed">
                Configure account-scoped risk parameters and automated circuit breaker rules.
              </p>
            </div>
          </div>

          {/* Account Selector & Identification Dropdown */}
          <div className="flex flex-col sm:items-end">
            <label className="text-[10px] uppercase font-bold tracking-wider text-[#5C6B7E] dark:text-[#98C1D9] mb-1 flex items-center space-x-1">
              <Building2 className="w-3 h-3 text-[#3D5A80] dark:text-[#98C1D9]" />
              <span>Configuring Account</span>
            </label>
            <div className="flex items-center space-x-2">
              <select
                value={activeAccountId}
                onChange={(e) => handleAccountSwitch(e.target.value)}
                disabled={loadingConfig || saving}
                className="text-xs font-semibold px-3 py-1.5 rounded-lg bg-slate-50 dark:bg-[#19202B] border border-[#98C1D9]/60 dark:border-[#3D4A5E] text-[#293241] dark:text-[#E0FBFC] focus:outline-hidden focus:border-[#3D5A80] dark:focus:border-[#98C1D9] cursor-pointer disabled:opacity-50"
              >
                {connectedAccounts.length > 0 ? (
                  connectedAccounts.map((acc) => {
                    const label = getFriendlyAccountLabel(acc.connectionId, acc.connection.broker);
                    return (
                      <option key={acc.connectionId} value={acc.connectionId}>
                        {label}
                      </option>
                    );
                  })
                ) : (
                  <>
                    <option value={DEFAULT_ACCOUNT_ID}>Zerodha — Primary</option>
                    <option value={DEFAULT_ANGELONE_ACCOUNT_ID}>Angel One — Main</option>
                  </>
                )}
              </select>
            </div>
          </div>
        </div>

        {/* Selected Broker & Account Badges */}
        <div className="mt-4 pt-3 border-t border-slate-100 dark:border-[#3D4A5E]/60 flex flex-wrap items-center gap-2 text-[11px]">
          <span className="text-[#5C6B7E] dark:text-[#98C1D9]">Active Target:</span>
          <span
            className={`px-2.5 py-0.5 rounded-full font-bold uppercase tracking-wider text-[10px] border ${
              isAngelOne
                ? 'bg-purple-500/10 text-purple-700 dark:text-purple-300 border-purple-500/30'
                : 'bg-[#3D5A80]/10 text-[#3D5A80] dark:text-[#98C1D9] border-[#3D5A80]/30'
            }`}
          >
            {brokerName}
          </span>
          <span className="font-mono text-slate-700 dark:text-slate-300 bg-slate-100 dark:bg-[#283244] px-2 py-0.5 rounded text-[10px] border border-slate-200 dark:border-slate-700">
            {activeAccountId}
          </span>
          <span
            className={`px-2 py-0.5 rounded font-mono text-[10px] uppercase font-bold flex items-center space-x-1 ${
              executionMode === 'OBSERVE_ONLY'
                ? 'bg-amber-500/10 text-amber-700 dark:text-amber-300 border border-amber-500/30'
                : 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border border-emerald-500/30'
            }`}
          >
            {executionMode === 'OBSERVE_ONLY' ? (
              <>
                <Eye className="w-3 h-3" />
                <span>OBSERVE_ONLY (Advisory)</span>
              </>
            ) : (
              <>
                <ShieldCheck className="w-3 h-3" />
                <span>ENFORCE (Circuit Breaker)</span>
              </>
            )}
          </span>
        </div>
      </div>

      {/* Advisory / Enforcement Notice for Angel One */}
      {isAngelOne && (
        <div
          className={`p-4 rounded-xl text-xs flex items-start space-x-2.5 shadow-xs ${
            executionMode === 'OBSERVE_ONLY'
              ? 'bg-purple-50 dark:bg-purple-950/20 border border-purple-200 dark:border-purple-900/40 text-purple-900 dark:text-purple-300'
              : 'bg-emerald-50 dark:bg-emerald-950/20 border border-emerald-200 dark:border-emerald-900/40 text-emerald-900 dark:text-emerald-300'
          }`}
        >
          {executionMode === 'OBSERVE_ONLY' ? (
            <Eye className="w-5 h-5 text-purple-600 dark:text-purple-400 shrink-0 mt-0.5" />
          ) : (
            <ShieldCheck className="w-5 h-5 text-emerald-600 dark:text-emerald-400 shrink-0 mt-0.5" />
          )}
          <div>
            <span className="font-bold">
              {executionMode === 'OBSERVE_ONLY'
                ? 'Angel One Advisory Mode (OBSERVE_ONLY):'
                : 'Angel One Controlled Enforcement Active (ENFORCE):'}
            </span>
            <p className="mt-0.5 leading-relaxed">
              {executionMode === 'OBSERVE_ONLY'
                ? 'Angel One is monitored in read-only observation mode. When daily loss thresholds are reached, real-time alerts and audit events are generated, but no automated circuit breaker locks are enforced.'
                : 'Angel One is actively monitored with account-scoped risk enforcement. When daily loss thresholds are breached, the Trading Firewall establishes an account-level circuit breaker lock for this Angel One account.'}
            </p>
          </div>
        </div>
      )}

      {/* Circuit Breaker Locked Notice */}
      {effectiveIsLocked && (
        <div className="p-4 rounded-xl bg-amber-50 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-900/40 text-amber-900 dark:text-amber-300 text-xs flex items-start space-x-2.5 shadow-xs">
          <AlertTriangle className="w-5 h-5 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
          <div>
            <span className="font-bold text-amber-900 dark:text-amber-200">Circuit Breaker Locked:</span>
            <p className="text-amber-800 dark:text-amber-300 mt-0.5">
              Trading Firewall is currently LOCKED for this account. Daily Loss Limit and Lockout Schedule cannot be modified during an active lock to preserve risk protection integrity.
            </p>
          </div>
        </div>
      )}

      <div className="bg-white dark:bg-[#1F2633] border border-[#98C1D9]/40 dark:border-[#3D4A5E] rounded-2xl p-6 sm:p-8 shadow-xs transition-colors duration-200">
        <div className="flex items-center justify-between pb-5 border-b border-[#98C1D9]/30 dark:border-[#3D4A5E]">
          <div className="flex items-center space-x-3">
            <div className="p-2.5 rounded-xl bg-slate-100 dark:bg-[#283244] text-[#3D5A80] dark:text-[#98C1D9] border border-[#98C1D9]/40 dark:border-[#3D4A5E]">
              <Sliders className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-base font-bold text-slate-900 dark:text-[#E0FBFC]">
                Risk Parameters &mdash; {brokerName}
              </h2>
              <p className="text-xs text-[#5C6B7E] dark:text-[#98C1D9]">
                Account-scoped rules enforced independently for {activeAccountId}
              </p>
            </div>
          </div>
        </div>

        {/* Action Status Message */}
        {message && (
          <div
            className={`mt-4 p-3.5 rounded-xl text-xs flex items-center space-x-2 font-medium ${
              message.type === 'success'
                ? 'bg-emerald-50 dark:bg-emerald-950/20 border border-emerald-200 dark:border-emerald-800/40 text-emerald-800 dark:text-emerald-300'
                : 'bg-rose-50 dark:bg-rose-950/20 border border-rose-200 dark:border-rose-800/40 text-rose-800 dark:text-rose-300'
            }`}
          >
            {message.type === 'success' ? (
              <CheckCircle className="w-4 h-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
            ) : (
              <AlertCircle className="w-4 h-4 shrink-0 text-rose-600 dark:text-rose-400" />
            )}
            <span>{message.text}</span>
          </div>
        )}

        {/* Validation Errors Notice */}
        {validationErrors.length > 0 && (
          <div className="mt-4 p-4 rounded-xl bg-rose-50 dark:bg-rose-950/20 border border-rose-200 dark:border-rose-800/40 text-rose-900 dark:text-rose-300 text-xs space-y-1">
            <p className="font-bold text-rose-900 dark:text-rose-200">Validation Notice:</p>
            <ul className="list-disc list-inside space-y-0.5">
              {validationErrors.map((err, i) => (
                <li key={i}>{err}</li>
              ))}
            </ul>
          </div>
        )}

        <form onSubmit={handleSave} className="mt-6 space-y-8">
          {/* SECTION 1: LOSS PROTECTION */}
          <div className="space-y-4">
            <div className="flex items-center space-x-2 border-b border-slate-100 dark:border-[#3D4A5E] pb-2">
              <TrendingDown className="w-4 h-4 text-[#EE6C4D] dark:text-[#98C1D9]" />
              <h3 className="text-xs font-bold uppercase tracking-wider text-slate-900 dark:text-[#E0FBFC]">
                1. Loss Protection
              </h3>
            </div>

            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className="text-xs font-semibold text-slate-800 dark:text-[#E0FBFC]">
                  Daily Loss Limit ({brokerName})
                </label>
                <span className="text-sm font-mono text-[#EE6C4D] dark:text-[#98C1D9] font-bold">
                  {formatINR(formData.dailyLossLimit || 0)}
                </span>
              </div>
              <input
                type="number"
                min="500"
                step="500"
                value={formData.dailyLossLimit}
                onChange={(e) => handleChange('dailyLossLimit', Number(e.target.value))}
                disabled={effectiveIsLocked || loadingConfig || saving}
                className="w-full bg-[#F3F8FA] dark:bg-[#283244] border border-[#98C1D9]/50 dark:border-[#3D4A5E] rounded-xl px-4 py-2.5 text-sm text-[#293241] dark:text-[#E0FBFC] font-mono focus:outline-hidden focus:border-[#3D5A80] dark:focus:border-[#98C1D9] transition-all disabled:opacity-60 disabled:cursor-not-allowed"
                required
              />
              {effectiveIsLocked ? (
                <p className="text-[11px] text-amber-700 dark:text-amber-400 font-semibold mt-1.5">
                  Locked while Trading Firewall circuit breaker is active for {brokerName}.
                </p>
              ) : (
                <p className="text-[11px] text-[#5C6B7E] dark:text-[#98C1D9] mt-1.5">
                  Minimum ₹500 in increments of ₹500. When cumulative daily loss in {brokerName} reaches this threshold, risk response triggers independently.
                </p>
              )}
            </div>

            {/* Master Toggle */}
            <div className="flex items-center justify-between p-4 rounded-xl bg-slate-50 dark:bg-[#19202B]/60 border border-[#98C1D9]/40 dark:border-[#3D4A5E]">
              <div>
                <span className="text-xs font-semibold text-slate-900 dark:text-[#E0FBFC] block">
                  {brokerName} Firewall Protection Active
                </span>
                <span className="text-[11px] text-[#5C6B7E] dark:text-[#98C1D9]">
                  {isAngelOne
                    ? 'Active monitoring and advisory alerting for Angel One'
                    : 'Master switch for automated trading risk monitoring and circuit breaker lockout'}
                </span>
              </div>
              <input
                type="checkbox"
                checked={formData.enabled}
                onChange={(e) => handleChange('enabled', e.target.checked)}
                disabled={loadingConfig || saving}
                className="w-4 h-4 accent-[#3D5A80] rounded cursor-pointer disabled:opacity-50"
              />
            </div>
          </div>

          {/* SECTION 2: LOCK BEHAVIOR */}
          <div className="space-y-4">
            <div className="flex items-center space-x-2 border-b border-slate-100 dark:border-[#3D4A5E] pb-2">
              <Clock className="w-4 h-4 text-[#3D5A80] dark:text-[#98C1D9]" />
              <h3 className="text-xs font-bold uppercase tracking-wider text-slate-900 dark:text-[#E0FBFC]">
                2. Lock Behavior
              </h3>
            </div>

            <div>
              <label className="text-xs font-semibold text-slate-800 dark:text-[#E0FBFC] block mb-2">
                Lockout Schedule
              </label>

              {/* Mode Selector */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <button
                  type="button"
                  disabled={effectiveIsLocked || loadingConfig || saving}
                  onClick={() => {
                    if (effectiveIsLocked) return;
                    handleChange('lockDurationType', 'FIXED');
                    if (!formData.lockDurationMinutes || formData.lockDurationMinutes < 60) {
                      handleChange('lockDurationMinutes', 60);
                    }
                  }}
                  className={`p-3.5 rounded-xl border text-left cursor-pointer transition-all disabled:opacity-60 disabled:cursor-not-allowed ${
                    (formData.lockDurationType ?? 'FIXED') === 'FIXED'
                      ? 'bg-white dark:bg-[#283244] border-[#3D5A80] dark:border-[#98C1D9] shadow-xs'
                      : 'bg-slate-50/80 dark:bg-[#19202B] border-[#98C1D9]/40 dark:border-[#3D4A5E] opacity-75 hover:opacity-100'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold text-slate-900 dark:text-[#E0FBFC]">Fixed Duration</span>
                    <span
                      className={`w-3.5 h-3.5 rounded-full border-2 flex items-center justify-center ${
                        (formData.lockDurationType ?? 'FIXED') === 'FIXED'
                          ? 'border-[#3D5A80] dark:border-[#98C1D9]'
                          : 'border-slate-400'
                      }`}
                    >
                      {(formData.lockDurationType ?? 'FIXED') === 'FIXED' && (
                        <span className="w-1.5 h-1.5 rounded-full bg-[#3D5A80] dark:bg-[#98C1D9]" />
                      )}
                    </span>
                  </div>
                  <p className="text-[11px] text-[#5C6B7E] dark:text-[#98C1D9] mt-1">
                    Lockout runs for a fixed number of hours after breach.
                  </p>
                </button>

                <button
                  type="button"
                  disabled={effectiveIsLocked || loadingConfig || saving}
                  onClick={() => {
                    if (effectiveIsLocked) return;
                    handleChange('lockDurationType', 'UNTIL_4PM');
                  }}
                  className={`p-3.5 rounded-xl border text-left cursor-pointer transition-all disabled:opacity-60 disabled:cursor-not-allowed ${
                    formData.lockDurationType === 'UNTIL_4PM'
                      ? 'bg-white dark:bg-[#283244] border-[#3D5A80] dark:border-[#98C1D9] shadow-xs'
                      : 'bg-slate-50/80 dark:bg-[#19202B] border-[#98C1D9]/40 dark:border-[#3D4A5E] opacity-75 hover:opacity-100'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold text-slate-900 dark:text-[#E0FBFC]">Until 4:00 PM</span>
                    <span
                      className={`w-3.5 h-3.5 rounded-full border-2 flex items-center justify-center ${
                        formData.lockDurationType === 'UNTIL_4PM'
                          ? 'border-[#3D5A80] dark:border-[#98C1D9]'
                          : 'border-slate-400'
                      }`}
                    >
                      {formData.lockDurationType === 'UNTIL_4PM' && (
                        <span className="w-1.5 h-1.5 rounded-full bg-[#3D5A80] dark:bg-[#98C1D9]" />
                      )}
                    </span>
                  </div>
                  <p className="text-[11px] text-[#5C6B7E] dark:text-[#98C1D9] mt-1">
                    Lockout remains in effect until 4:00 PM IST on the trading day.
                  </p>
                </button>
              </div>

              {/* Mode-specific input or confirmation */}
              {(formData.lockDurationType ?? 'FIXED') === 'FIXED' ? (
                <div className="mt-3">
                  <div className="flex items-center justify-between mb-1.5">
                    <label className="text-xs text-slate-700 dark:text-slate-300">
                      Lock Duration (Hours)
                    </label>
                    <span className="text-xs font-mono font-semibold text-[#3D5A80] dark:text-[#98C1D9]">
                      {lockHours} {lockHours === 1 ? 'Hour' : 'Hours'} ({formData.lockDurationMinutes || 60}m)
                    </span>
                  </div>
                  <input
                    type="number"
                    min="1"
                    max="48"
                    step="1"
                    value={lockHours}
                    onChange={(e) => handleHoursChange(Number(e.target.value))}
                    disabled={effectiveIsLocked || loadingConfig || saving}
                    className="w-full bg-[#F3F8FA] dark:bg-[#283244] border border-[#98C1D9]/50 dark:border-[#3D4A5E] rounded-xl px-4 py-2.5 text-sm text-[#293241] dark:text-[#E0FBFC] font-mono focus:outline-hidden focus:border-[#3D5A80] dark:focus:border-[#98C1D9] transition-all disabled:opacity-60 disabled:cursor-not-allowed"
                    required
                  />
                  {effectiveIsLocked ? (
                    <p className="text-[11px] text-amber-700 dark:text-amber-400 font-semibold mt-1.5">
                      Lockout schedule cannot be modified during an active lock.
                    </p>
                  ) : (
                    <p className="text-[11px] text-[#5C6B7E] dark:text-[#98C1D9] mt-1.5">
                      Minimum 1 hour, in increments of 1 hour.
                    </p>
                  )}
                </div>
              ) : (
                <div className="mt-3 p-3.5 rounded-xl bg-amber-500/10 border border-amber-500/30 text-amber-900 dark:text-amber-200 text-xs flex items-center space-x-2.5">
                  <Clock className="w-4 h-4 text-amber-600 dark:text-amber-400 shrink-0" />
                  <span>
                    Trading lockout will strictly hold until <strong>4:00 PM IST (Asia/Kolkata)</strong> on the current trading date.
                  </span>
                </div>
              )}
            </div>
          </div>

          {/* SECTION 3: WARNING LEVELS */}
          <div className="space-y-4">
            <div className="flex items-center space-x-2 border-b border-slate-100 dark:border-[#3D4A5E] pb-2">
              <Bell className="w-4 h-4 text-amber-500 dark:text-amber-400" />
              <h3 className="text-xs font-bold uppercase tracking-wider text-slate-900 dark:text-[#E0FBFC]">
                3. Warning Levels
              </h3>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="text-xs font-semibold text-slate-800 dark:text-[#E0FBFC]">
                    Warning Level 1 (%)
                  </label>
                  <span className="text-xs font-mono text-[#EE6C4D] dark:text-[#98C1D9] font-bold">
                    {formData.warningThreshold1}% ({formatINR(((formData.dailyLossLimit || 0) * (formData.warningThreshold1 || 0)) / 100)})
                  </span>
                </div>
                <input
                  type="number"
                  min="1"
                  max="99"
                  step="1"
                  value={formData.warningThreshold1}
                  onChange={(e) => handleChange('warningThreshold1', Number(e.target.value))}
                  disabled={loadingConfig || saving}
                  className="w-full bg-[#F3F8FA] dark:bg-[#283244] border border-[#98C1D9]/50 dark:border-[#3D4A5E] rounded-xl px-4 py-2.5 text-sm text-[#293241] dark:text-[#E0FBFC] font-mono focus:outline-hidden focus:border-[#3D5A80] dark:focus:border-[#98C1D9] transition-all disabled:opacity-60"
                  required
                />
                <p className="text-[11px] text-[#5C6B7E] dark:text-[#98C1D9] mt-1.5">
                  Initial alert threshold. Status transitions to Warning state.
                </p>
              </div>

              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="text-xs font-semibold text-slate-800 dark:text-[#E0FBFC]">
                    Warning Level 2 (%)
                  </label>
                  <span className="text-xs font-mono text-[#EE6C4D] dark:text-[#98C1D9] font-bold">
                    {formData.warningThreshold2}% ({formatINR(((formData.dailyLossLimit || 0) * (formData.warningThreshold2 || 0)) / 100)})
                  </span>
                </div>
                <input
                  type="number"
                  min="2"
                  max="100"
                  step="1"
                  value={formData.warningThreshold2}
                  onChange={(e) => handleChange('warningThreshold2', Number(e.target.value))}
                  disabled={loadingConfig || saving}
                  className="w-full bg-[#F3F8FA] dark:bg-[#283244] border border-[#98C1D9]/50 dark:border-[#3D4A5E] rounded-xl px-4 py-2.5 text-sm text-[#293241] dark:text-[#E0FBFC] font-mono focus:outline-hidden focus:border-[#3D5A80] dark:focus:border-[#98C1D9] transition-all disabled:opacity-60"
                  required
                />
                <p className="text-[11px] text-[#5C6B7E] dark:text-[#98C1D9] mt-1.5">
                  Critical warning threshold approaching maximum allowable loss.
                </p>
              </div>
            </div>
          </div>

          {/* SECTION 4: P&L CALCULATION */}
          <div className="space-y-4">
            <div className="flex items-center space-x-2 border-b border-slate-100 dark:border-[#3D4A5E] pb-2">
              <Calculator className="w-4 h-4 text-[#3D5A80] dark:text-[#98C1D9]" />
              <h3 className="text-xs font-bold uppercase tracking-wider text-slate-900 dark:text-[#E0FBFC]">
                4. P&L Calculation
              </h3>
            </div>

            <div className="bg-slate-50/80 dark:bg-[#19202B]/60 p-5 rounded-xl border border-[#98C1D9]/40 dark:border-[#3D4A5E] space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <span className="text-xs font-medium text-slate-900 dark:text-[#E0FBFC] block">
                    Include Realised P&L
                  </span>
                  <span className="text-[11px] text-[#5C6B7E] dark:text-[#98C1D9]">
                    Include closed trade profits and losses in the {brokerName} daily loss evaluation
                  </span>
                </div>
                <input
                  type="checkbox"
                  checked={formData.includeRealisedPnl}
                  onChange={(e) => handleChange('includeRealisedPnl', e.target.checked)}
                  disabled={loadingConfig || saving}
                  className="w-4 h-4 accent-[#3D5A80] rounded cursor-pointer disabled:opacity-50"
                />
              </div>

              <div className="flex items-center justify-between pt-3 border-t border-slate-200/60 dark:border-[#3D4A5E]">
                <div>
                  <span className="text-xs font-medium text-slate-900 dark:text-[#E0FBFC] block">
                    Include Unrealised P&L (MTM)
                  </span>
                  <span className="text-[11px] text-[#5C6B7E] dark:text-[#98C1D9]">
                    Include open position mark-to-market valuations in the {brokerName} daily loss evaluation
                  </span>
                </div>
                <input
                  type="checkbox"
                  checked={formData.includeUnrealisedPnl}
                  onChange={(e) => handleChange('includeUnrealisedPnl', e.target.checked)}
                  disabled={loadingConfig || saving}
                  className="w-4 h-4 accent-[#3D5A80] rounded cursor-pointer disabled:opacity-50"
                />
              </div>
            </div>
          </div>

          {/* Action Buttons */}
          <div className="flex items-center justify-between pt-4 border-t border-slate-100 dark:border-[#3D4A5E]">
            <div className="text-xs text-[#5C6B7E] dark:text-[#98C1D9] flex items-center space-x-1.5">
              <span>Account:</span>
              <span className="font-mono font-bold text-slate-800 dark:text-slate-200">{activeAccountId}</span>
            </div>

            <button
              type="submit"
              disabled={saving || loadingConfig}
              className="flex items-center space-x-2 bg-[#3D5A80] hover:bg-[#2B3E58] dark:bg-[#98C1D9] dark:hover:bg-[#E0FBFC] text-white dark:text-[#293241] font-semibold px-6 py-2.5 rounded-xl transition-all shadow-xs disabled:opacity-50 cursor-pointer text-xs tracking-wide"
            >
              {saving ? (
                <>
                  <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                  <span>{verifying ? 'Verifying Persistence...' : 'Saving Configuration...'}</span>
                </>
              ) : (
                <>
                  <Save className="w-3.5 h-3.5" />
                  <span>Save {brokerName} Configuration</span>
                </>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
