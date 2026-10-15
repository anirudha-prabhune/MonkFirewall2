import { BrokerAccountCapital } from '../../server/brokers/types';

/**
 * Validates whether a returned BrokerAccountCapital payload matches the expected broker
 * and permissible dataSource (preventing cross-broker pollution and fabricated data).
 */
export function validateBrokerCapitalPayload(
  broker: 'zerodha' | 'angelone',
  capital: BrokerAccountCapital | null
): boolean {
  if (!capital) return false;
  if (broker === 'angelone') {
    return capital.broker === 'angelone' && capital.dataSource === 'ANGELONE_LIVE';
  }
  if (broker === 'zerodha') {
    return capital.broker === 'zerodha' && (capital.dataSource === 'ZERODHA_LIVE' || capital.dataSource === 'MOCK_DATA');
  }
  return false;
}

/**
 * Authoritative client-side state manager for broker capital retrieval and broker switching.
 * Enforces:
 * 1. Immediate capital clearance on broker change.
 * 2. Strict sequence number matching (discards out-of-order in-flight responses).
 * 3. Active-broker verification (discards responses from a previously selected broker).
 * 4. Fail-closed error and disconnect handling (null capital, never stale or cross-broker).
 */
export class BrokerCapitalStateManager {
  private activeBroker: 'zerodha' | 'angelone' = 'zerodha';
  private capitalRequestId: number = 0;
  private capital: BrokerAccountCapital | null = null;
  private loading: boolean = false;

  public getActiveBroker(): 'zerodha' | 'angelone' {
    return this.activeBroker;
  }

  public getCapital(): BrokerAccountCapital | null {
    return this.capital;
  }

  public isLoading(): boolean {
    return this.loading;
  }

  public getRequestId(): number {
    return this.capitalRequestId;
  }

  /**
   * Immediately clears capital and transitions loading state upon broker switch.
   * Increments the request ID to invalidate any in-flight requests for the previous broker.
   */
  public handleSelectBroker(broker: 'zerodha' | 'angelone'): { capital: null; loading: boolean } {
    this.capitalRequestId += 1;
    this.activeBroker = broker;
    this.capital = null;
    this.loading = true;
    return { capital: null, loading: true };
  }

  /**
   * Prepares a new fetch request for target broker, advancing the sequence counter.
   */
  public prepareFetch(targetBroker: 'zerodha' | 'angelone'): number {
    this.activeBroker = targetBroker;
    return ++this.capitalRequestId;
  }

  /**
   * Processes a resolved capital payload with strict sequence and active broker validation.
   * Returns true if the payload was accepted and state updated; false if safely discarded.
   */
  public applyCapitalSuccess(
    reqId: number,
    targetBroker: 'zerodha' | 'angelone',
    payload: BrokerAccountCapital | null
  ): { accepted: boolean; capital: BrokerAccountCapital | null } {
    // Sequence check & Active broker check
    if (reqId !== this.capitalRequestId || this.activeBroker !== targetBroker) {
      return { accepted: false, capital: this.capital };
    }

    if (!payload || !validateBrokerCapitalPayload(targetBroker, payload)) {
      this.capital = null;
      return { accepted: true, capital: null };
    }

    this.capital = payload;
    return { accepted: true, capital: payload };
  }

  /**
   * Handles request failure fail-closed, ensuring late errors do not overwrite state.
   */
  public applyCapitalFailure(
    reqId: number,
    targetBroker: 'zerodha' | 'angelone'
  ): { accepted: boolean } {
    if (reqId === this.capitalRequestId && this.activeBroker === targetBroker) {
      this.capital = null;
      return { accepted: true };
    }
    return { accepted: false };
  }

  /**
   * Finalizes loading state only if the request sequence is still active.
   */
  public finalizeFetch(reqId: number, targetBroker: 'zerodha' | 'angelone'): boolean {
    if (reqId === this.capitalRequestId && this.activeBroker === targetBroker) {
      this.loading = false;
      return true;
    }
    return false;
  }
}
