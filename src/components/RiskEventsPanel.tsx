import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  Activity,
  AlertOctagon,
  AlertTriangle,
  AlertCircle,
  Info,
  RefreshCw,
  Clock,
  ShieldAlert,
  CheckCircle2,
  Lock,
  Layers,
  Filter,
} from 'lucide-react';
import { RiskEvent, RiskEventSeverity, RiskEventType } from '../types/events';
import { getAuthHeaders } from '../services/firebase';

interface RiskEventsPanelProps {
  selectedAccountId: string;
  selectedBroker: 'zerodha' | 'angelone';
  userUid?: string;
  onRefreshTriggered?: () => void;
}

export function getAccountDisplayName(accountId?: string, broker?: string): string {
  if (!accountId) return broker === 'angelone' ? 'Angel One (Default)' : 'Zerodha (Default)';
  if (accountId === 'acc_mt_angelone_default' || accountId.includes('angelone')) {
    return 'Angel One (Default)';
  }
  if (accountId === 'acc_mt_zerodha_default' || accountId.includes('zerodha')) {
    return 'Zerodha (Default)';
  }
  const clean = accountId.replace(/^(acc_mt_|acc_)/, '').replace(/_/g, ' ');
  return clean.charAt(0).toUpperCase() + clean.slice(1);
}

export function getEventTypeTitle(type: RiskEventType): string {
  switch (type) {
    case 'RISK_WARNING_70':
      return 'Risk Warning (70% Threshold)';
    case 'RISK_WARNING_90':
      return 'Critical Warning (90% Threshold)';
    case 'RISK_WARNING':
      return 'Loss Threshold Warning';
    case 'LOSS_LIMIT_BREACHED':
      return 'Daily Loss Limit Breached';
    case 'TRADING_LOCK_CREATED':
      return 'Trading Firewall Circuit Breaker Locked';
    case 'TRADING_LOCK_EXPIRED':
      return 'Trading Lock Duration Completed';
    case 'UNRESOLVED_BREACH_RELOCKED':
      return 'Unresolved Loss Breach Re-Locked';
    case 'STALE_DATA_DETECTED':
      return 'Stale Market Data Detected';
    case 'INVALID_PNL_REJECTED':
      return 'Invalid P&L Structure Rejected';
    case 'BROKER_DISCONNECTED':
      return 'Broker Session Disconnected';
    case 'AUTH_FAILURE':
      return 'Broker Authentication Failure';
    case 'API_TIMEOUT':
      return 'Broker API Timeout';
    case 'BROKER_RECONNECTED':
      return 'Broker Session Restored';
    case 'DATA_FEED_RECOVERED':
      return 'Fresh Data Feed Recovered';
    case 'AUTHORIZED_SESSION_RESET':
      return 'Authorized Operator Reset';
    case 'CONFIG_UPDATED':
      return 'Risk Config Modified';
    default:
      return String(type).replace(/_/g, ' ');
  }
}

export const RiskEventsPanel: React.FC<RiskEventsPanelProps> = ({
  selectedAccountId,
  selectedBroker,
  userUid,
  onRefreshTriggered,
}) => {
  const [events, setEvents] = useState<RiskEvent[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [severityFilter, setSeverityFilter] = useState<string>('all');
  const [persistenceDegraded, setPersistenceDegraded] = useState<boolean>(false);
  const [bufferedCount, setBufferedCount] = useState<number>(0);
  const requestIdRef = useRef<number>(0);

  const accountLabel = getAccountDisplayName(selectedAccountId, selectedBroker);

  const loadEvents = useCallback(async () => {
    const currentReq = ++requestIdRef.current;
    setLoading(true);
    setError(null);

    try {
      const headers = await getAuthHeaders({
        'x-account-id': selectedAccountId,
      });

      const res = await fetch(
        `/api/risk/events?accountId=${encodeURIComponent(selectedAccountId)}&limit=50`,
        { headers }
      );

      // Reject stale asynchronous responses if account switched while fetch was pending
      if (currentReq !== requestIdRef.current) {
        return;
      }

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || `Server HTTP error ${res.status}`);
      }

      const data = await res.json();
      if (currentReq === requestIdRef.current) {
        setEvents(data.events || []);
        setPersistenceDegraded(!!data.persistenceDegraded);
        setBufferedCount(Number(data.bufferedCount) || 0);
      }
    } catch (err) {
      if (currentReq === requestIdRef.current) {
        setError(err instanceof Error ? err.message : 'Failed to load risk events');
      }
    } finally {
      if (currentReq === requestIdRef.current) {
        setLoading(false);
      }
    }
  }, [selectedAccountId]);

  // Account switching: immediately clear previous events and fetch new account events
  useEffect(() => {
    setEvents([]);
    loadEvents();
  }, [selectedAccountId, selectedBroker, loadEvents]);

  const handleRefresh = () => {
    loadEvents();
    if (onRefreshTriggered) {
      onRefreshTriggered();
    }
  };

  const filteredEvents = events.filter((ev) => {
    if (severityFilter === 'all') return true;
    return (ev.severity || 'info') === severityFilter;
  });

  const formatTimestamp = (ts: string) => {
    try {
      const date = new Date(ts);
      return date.toLocaleString('en-IN', {
        timeZone: 'Asia/Kolkata',
        day: '2-digit',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: true,
      }) + ' IST';
    } catch {
      return ts;
    }
  };

  const getSeverityBadge = (severity?: RiskEventSeverity) => {
    switch (severity) {
      case 'critical':
        return (
          <span className="inline-flex items-center space-x-1 px-2 py-0.5 rounded text-[10px] font-mono font-bold uppercase tracking-wider bg-rose-500/15 text-rose-700 dark:text-rose-300 border border-rose-500/30">
            <AlertOctagon className="w-3 h-3 shrink-0" />
            <span>CRITICAL</span>
          </span>
        );
      case 'error':
        return (
          <span className="inline-flex items-center space-x-1 px-2 py-0.5 rounded text-[10px] font-mono font-bold uppercase tracking-wider bg-red-500/15 text-red-700 dark:text-red-300 border border-red-500/30">
            <AlertCircle className="w-3 h-3 shrink-0" />
            <span>ERROR</span>
          </span>
        );
      case 'warning':
        return (
          <span className="inline-flex items-center space-x-1 px-2 py-0.5 rounded text-[10px] font-mono font-bold uppercase tracking-wider bg-amber-500/15 text-amber-700 dark:text-amber-300 border border-amber-500/30">
            <AlertTriangle className="w-3 h-3 shrink-0" />
            <span>WARNING</span>
          </span>
        );
      case 'info':
      default:
        return (
          <span className="inline-flex items-center space-x-1 px-2 py-0.5 rounded text-[10px] font-mono font-bold uppercase tracking-wider bg-sky-500/15 text-sky-700 dark:text-sky-300 border border-sky-500/30">
            <Info className="w-3 h-3 shrink-0" />
            <span>INFO</span>
          </span>
        );
    }
  };

  const getPersistenceBadge = (ev: RiskEvent) => {
    if (ev.persisted === false || ev.persistenceStatus === 'buffered') {
      return (
        <span className="px-1.5 py-0.5 rounded text-[9px] font-mono font-semibold uppercase bg-amber-500/10 text-amber-700 dark:text-amber-300 border border-amber-500/20">
          RAM-Buffered
        </span>
      );
    }
    if (ev.persisted === true || ev.persistenceStatus === 'durable') {
      return (
        <span className="px-1.5 py-0.5 rounded text-[9px] font-mono font-semibold uppercase bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border border-emerald-500/20">
          Durable
        </span>
      );
    }
    return null;
  };

  return (
    <div className="bg-white dark:bg-[#1F2633] rounded-xl border border-[#98C1D9]/40 dark:border-[#3D4A5E] shadow-xs p-5 space-y-4">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 border-b border-slate-100 dark:border-[#3D4A5E]">
        <div className="flex items-center space-x-3">
          <div className="p-2.5 rounded-xl bg-[#3D5A80]/10 text-[#3D5A80] dark:text-[#98C1D9]">
            <Activity className="w-5 h-5" />
          </div>
          <div>
            <div className="flex items-center space-x-2">
              <h3 className="text-sm font-bold text-[#293241] dark:text-[#E0FBFC]">
                Risk Activity & Operational Audit
              </h3>
              <span className="px-2 py-0.5 rounded font-mono text-[10px] font-bold uppercase bg-slate-100 dark:bg-[#283244] text-[#3D5A80] dark:text-[#98C1D9] border border-[#98C1D9]/30 dark:border-[#3D4A5E]">
                {accountLabel}
              </span>
            </div>
            <p className="text-xs text-[#5C6B7E] dark:text-[#98C1D9] mt-0.5">
              Authoritative risk events, threshold warnings, circuit breaker locks, and connection logs
            </p>
          </div>
        </div>

        {/* Action controls */}
        <div className="flex items-center space-x-2">
          {/* Severity filter */}
          <div className="flex items-center space-x-1 bg-slate-100 dark:bg-[#19202B] p-1 rounded-lg border border-[#98C1D9]/30 dark:border-[#3D4A5E] text-xs font-mono">
            <Filter className="w-3 h-3 text-[#5C6B7E] dark:text-[#98C1D9] ml-1" />
            <select
              value={severityFilter}
              onChange={(e) => setSeverityFilter(e.target.value)}
              className="bg-transparent text-xs font-medium text-slate-800 dark:text-slate-200 focus:outline-hidden cursor-pointer"
            >
              <option value="all">All Severities</option>
              <option value="critical">Critical Only</option>
              <option value="warning">Warning Only</option>
              <option value="error">Error Only</option>
              <option value="info">Info Only</option>
            </select>
          </div>

          {/* Refresh button */}
          <button
            onClick={handleRefresh}
            disabled={loading}
            className="p-2 rounded-lg bg-slate-100 hover:bg-slate-200 dark:bg-[#283244] dark:hover:bg-[#323F54] text-[#3D5A80] dark:text-[#98C1D9] transition-colors cursor-pointer disabled:opacity-50"
            title="Refresh events"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {/* Persistence degradation notification banner */}
      {persistenceDegraded && (
        <div className="p-3 rounded-xl bg-amber-500/10 border border-amber-500/30 text-amber-800 dark:text-amber-200 text-xs flex items-center justify-between font-mono">
          <div className="flex items-center space-x-2">
            <AlertTriangle className="w-4 h-4 text-amber-600 dark:text-amber-400 shrink-0" />
            <span>
              <strong>Persistence Degraded:</strong> Audit events are currently RAM-buffered in memory ({bufferedCount} buffered).
            </span>
          </div>
          <span className="px-2 py-0.5 rounded text-[10px] bg-amber-500/20 text-amber-900 dark:text-amber-100 font-bold uppercase">
            RAM-Buffered
          </span>
        </div>
      )}

      {/* Content Body */}
      {loading && events.length === 0 ? (
        <div className="py-8 text-center text-slate-400 dark:text-slate-500 font-mono text-xs flex items-center justify-center space-x-2">
          <RefreshCw className="w-4 h-4 animate-spin text-[#EE6C4D]" />
          <span>Loading account risk events...</span>
        </div>
      ) : error ? (
        <div className="p-4 rounded-xl bg-rose-500/10 border border-rose-500/30 text-rose-800 dark:text-rose-200 text-xs flex items-center justify-between">
          <span>Failed to load events: {error}</span>
          <button
            onClick={loadEvents}
            className="px-3 py-1 bg-rose-600 hover:bg-rose-700 text-white rounded font-bold cursor-pointer transition-colors"
          >
            Retry
          </button>
        </div>
      ) : filteredEvents.length === 0 ? (
        <div className="py-8 text-center text-slate-400 dark:text-slate-500 text-xs space-y-1">
          <ShieldAlert className="w-6 h-6 mx-auto opacity-40 mb-1" />
          <p className="font-semibold text-slate-600 dark:text-slate-400">
            No risk events recorded for {accountLabel}
          </p>
          <p className="text-[11px] font-mono">
            {severityFilter !== 'all'
              ? `No events matching '${severityFilter}' filter`
              : 'All risk evaluations are operating normally within limits'}
          </p>
        </div>
      ) : (
        <div className="space-y-2.5 max-h-[420px] overflow-y-auto pr-1 scrollbar-thin">
          {filteredEvents.map((ev, index) => {
            const title = getEventTypeTitle(ev.type);
            const formattedTime = formatTimestamp(ev.timestamp);

            return (
              <div
                key={ev.id || `${ev.timestamp}_${index}`}
                className="p-3.5 rounded-xl border border-slate-100 dark:border-[#3D4A5E]/70 bg-slate-50/50 dark:bg-[#19202B]/40 hover:bg-slate-50 dark:hover:bg-[#19202B]/80 transition-colors text-xs space-y-1.5"
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center space-x-2">
                    {getSeverityBadge(ev.severity)}
                    {getPersistenceBadge(ev)}
                    <span className="font-bold text-slate-900 dark:text-[#E0FBFC]">
                      {title}
                    </span>
                  </div>

                  <span className="font-mono text-[10px] text-[#5C6B7E] dark:text-[#98C1D9] shrink-0 flex items-center space-x-1">
                    <Clock className="w-3 h-3 text-slate-400" />
                    <span>{formattedTime}</span>
                  </span>
                </div>

                <p className="text-slate-700 dark:text-slate-300 leading-relaxed font-sans">
                  {ev.message}
                </p>

                {/* Metrics detail if present */}
                {ev.metrics && (ev.metrics.lossAmount !== undefined || ev.metrics.dailyLossLimit !== undefined) && (
                  <div className="flex flex-wrap items-center gap-3 pt-1 border-t border-slate-100 dark:border-[#3D4A5E]/40 text-[11px] font-mono text-[#5C6B7E] dark:text-[#98C1D9]">
                    {ev.metrics.lossAmount !== undefined && (
                      <span>
                        Loss: <strong className="text-slate-900 dark:text-white">₹{ev.metrics.lossAmount.toLocaleString('en-IN')}</strong>
                      </span>
                    )}
                    {ev.metrics.dailyLossLimit !== undefined && (
                      <span>
                        Limit: <strong className="text-slate-900 dark:text-white">₹{ev.metrics.dailyLossLimit.toLocaleString('en-IN')}</strong>
                      </span>
                    )}
                    {ev.metrics.lossUtilizedPercent !== undefined && (
                      <span>
                        Utilized: <strong className="text-slate-900 dark:text-white">{ev.metrics.lossUtilizedPercent.toFixed(1)}%</strong>
                      </span>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
