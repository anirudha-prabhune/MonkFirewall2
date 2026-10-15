import React from 'react';
import { BrokerAccountCapital } from '../types/broker';
import { Wallet, RefreshCw, AlertCircle, Clock, ShieldAlert } from 'lucide-react';

interface AccountCapitalCardProps {
  selectedBroker: 'zerodha' | 'angelone' | 'mock';
  capital: BrokerAccountCapital | null;
  loading: boolean;
  onRefresh?: () => void;
}

export const AccountCapitalCard: React.FC<AccountCapitalCardProps> = ({
  selectedBroker,
  capital,
  loading,
  onRefresh,
}) => {
  const formatCurrency = (val: number | null | undefined): string => {
    if (val === null || val === undefined || isNaN(val)) return 'Unavailable';
    return new Intl.NumberFormat('en-IN', {
      style: 'currency',
      currency: 'INR',
      maximumFractionDigits: 2,
    }).format(val);
  };

  const getSourceBadgeColor = (source?: string) => {
    switch (source) {
      case 'ZERODHA_LIVE':
        return 'bg-amber-500/10 text-amber-600 border-amber-500/30 dark:text-amber-400';
      case 'ANGELONE_LIVE':
        return 'bg-sky-500/10 text-sky-600 border-sky-500/30 dark:text-sky-400';
      case 'MOCK_DATA':
      default:
        return 'bg-purple-500/10 text-purple-600 border-purple-500/30 dark:text-purple-400';
    }
  };

  const isDisconnectedOrStale = !capital || capital.isStale || capital.netBalance === null;

  return (
    <div className="bg-white dark:bg-[#1F2633] rounded-2xl border border-[#98C1D9]/40 dark:border-[#3D4A5E] p-6 shadow-xs transition-colors mb-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 mb-5 border-b border-[#98C1D9]/20 dark:border-[#3D4A5E]/60 pb-4">
        <div className="flex items-center gap-3">
          <div className="p-2.5 rounded-xl bg-[#0F2027]/5 dark:bg-[#98C1D9]/10 text-[#0F2027] dark:text-[#98C1D9]">
            <Wallet className="w-5 h-5" />
          </div>
          <div>
            <h3 className="text-base font-bold text-[#0F2027] dark:text-white flex items-center gap-2">
              Account Capital & Funds
              <span className="text-xs font-normal text-[#5C6B7E] dark:text-[#98C1D9] capitalize">
                ({selectedBroker === 'angelone' ? 'Angel One' : selectedBroker === 'zerodha' ? 'Zerodha' : 'Mock Mode'})
              </span>
            </h3>
            <p className="text-xs text-[#5C6B7E] dark:text-[#98C1D9]">
              Read-only funds and margin breakdown sourced directly from broker API
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {capital && (
            <>
              <span className={`px-2.5 py-1 text-[11px] font-mono font-semibold rounded-full border ${getSourceBadgeColor(capital.dataSource)}`}>
                {capital.dataSource}
              </span>

              <span
                className={`px-2.5 py-1 text-[11px] font-mono font-semibold rounded-full border ${
                  capital.isAfterHours
                    ? 'bg-indigo-500/10 text-indigo-600 border-indigo-500/30 dark:text-indigo-400'
                    : 'bg-emerald-500/10 text-emerald-600 border-emerald-500/30 dark:text-emerald-400'
                }`}
              >
                {capital.isAfterHours ? 'AFTER-HOURS / CLOSED' : 'TRADING HOURS'}
              </span>
            </>
          )}

          {onRefresh && (
            <button
              onClick={onRefresh}
              disabled={loading}
              title="Refresh capital snapshot"
              className="p-2 rounded-lg hover:bg-slate-100 dark:hover:bg-[#2A3446] text-[#5C6B7E] dark:text-[#98C1D9] transition-colors disabled:opacity-50"
            >
              <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            </button>
          )}
        </div>
      </div>

      {/* Body: Disconnected / Stale / Unavailable Warning */}
      {isDisconnectedOrStale ? (
        <div className="p-4 rounded-xl bg-amber-500/10 border border-amber-500/30 text-amber-700 dark:text-amber-300 text-xs flex items-center gap-3">
          <AlertCircle className="w-5 h-5 shrink-0 text-amber-500" />
          <div>
            <span className="font-semibold block text-sm">Broker Capital Unavailable / Stale</span>
            <p className="mt-0.5">
              {capital?.semanticNote ||
                `Connect your ${selectedBroker === 'angelone' ? 'Angel One' : 'Zerodha'} account to view real-time account balances, trading margins, and withdrawable funds.`}
            </p>
          </div>
        </div>
      ) : (
        /* Metric Grid */
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
          {/* 1. Net Balance */}
          <div className="p-4 rounded-xl bg-slate-50 dark:bg-[#19202B]/80 border border-slate-200/80 dark:border-[#3D4A5E]">
            <span className="text-[11px] font-medium uppercase tracking-wider text-[#5C6B7E] dark:text-[#98C1D9] block mb-1">
              Net Account Balance
            </span>
            <span className="text-lg font-bold font-mono text-[#0F2027] dark:text-white">
              {formatCurrency(capital.netBalance)}
            </span>
            <span className="text-[10px] text-[#5C6B7E] dark:text-[#98C1D9] block mt-1">
              Total account valuation
            </span>
          </div>

          {/* 2. Available Cash */}
          <div className="p-4 rounded-xl bg-slate-50 dark:bg-[#19202B]/80 border border-slate-200/80 dark:border-[#3D4A5E]">
            <span className="text-[11px] font-medium uppercase tracking-wider text-[#5C6B7E] dark:text-[#98C1D9] block mb-1">
              Available Cash
            </span>
            <span className="text-lg font-bold font-mono text-emerald-600 dark:text-emerald-400">
              {formatCurrency(capital.availableCash)}
            </span>
            <span className="text-[10px] text-[#5C6B7E] dark:text-[#98C1D9] block mt-1">
              Free unencumbered cash
            </span>
          </div>

          {/* 3. Available Trading Margin */}
          <div className="p-4 rounded-xl bg-slate-50 dark:bg-[#19202B]/80 border border-slate-200/80 dark:border-[#3D4A5E]">
            <span className="text-[11px] font-medium uppercase tracking-wider text-[#5C6B7E] dark:text-[#98C1D9] block mb-1">
              Trading Margin
            </span>
            <span className="text-lg font-bold font-mono text-sky-600 dark:text-sky-400">
              {formatCurrency(capital.availableTradingMargin)}
            </span>
            <span className="text-[10px] text-[#5C6B7E] dark:text-[#98C1D9] block mt-1">
              Limit for new orders
            </span>
          </div>

          {/* 4. Utilized Margin */}
          <div className="p-4 rounded-xl bg-slate-50 dark:bg-[#19202B]/80 border border-slate-200/80 dark:border-[#3D4A5E]">
            <span className="text-[11px] font-medium uppercase tracking-wider text-[#5C6B7E] dark:text-[#98C1D9] block mb-1">
              Utilized Margin
            </span>
            <span className="text-lg font-bold font-mono text-amber-600 dark:text-amber-400">
              {formatCurrency(capital.utilizedMargin)}
            </span>
            <span className="text-[10px] text-[#5C6B7E] dark:text-[#98C1D9] block mt-1">
              Blocked span/exposure
            </span>
          </div>

          {/* 5. Withdrawable Funds */}
          <div className="p-4 rounded-xl bg-slate-50 dark:bg-[#19202B]/80 border border-slate-200/80 dark:border-[#3D4A5E]">
            <span className="text-[11px] font-medium uppercase tracking-wider text-[#5C6B7E] dark:text-[#98C1D9] block mb-1">
              Withdrawable Funds
            </span>
            {capital.withdrawableFunds !== null ? (
              <span className="text-lg font-bold font-mono text-indigo-600 dark:text-indigo-400">
                {formatCurrency(capital.withdrawableFunds)}
              </span>
            ) : (
              <span className="text-xs font-mono text-slate-400 dark:text-slate-500 block py-1">
                N/A (Not provided)
              </span>
            )}
            <span className="text-[10px] text-[#5C6B7E] dark:text-[#98C1D9] block mt-1">
              {selectedBroker === 'zerodha' ? 'Unsupported by Kite Margins API' : 'Eligible for payout'}
            </span>
          </div>
        </div>
      )}

      {/* Footer Meta */}
      {capital && (
        <div className="mt-4 pt-3 border-t border-slate-100 dark:border-[#3D4A5E]/60 text-[11px] text-[#5C6B7E] dark:text-[#98C1D9] flex flex-wrap items-center justify-between gap-2 font-mono">
          <div className="flex items-center gap-1.5">
            <Clock className="w-3.5 h-3.5 text-slate-400" />
            <span>As of: {new Date(capital.asOf).toLocaleTimeString('en-IN', { hour12: true })}</span>
          </div>
          <div className="flex items-center gap-1.5">
            <ShieldAlert className="w-3.5 h-3.5 text-slate-400" />
            <span>{capital.semanticNote}</span>
          </div>
        </div>
      )}
    </div>
  );
};
