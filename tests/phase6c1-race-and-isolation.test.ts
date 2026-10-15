import { strict as assert } from 'assert';
import { BrokerAccountCapital } from '../server/brokers/types';
import {
  BrokerCapitalStateManager,
  validateBrokerCapitalPayload,
} from '../src/utils/brokerCapitalState';

/**
 * MonkFirewall2 Phase 6C.1/6C.3: Broker Switch & Asynchronous Capital Race Test Suite
 *
 * Exercises the actual production state-management logic in `src/utils/brokerCapitalState.ts`
 * (used directly by `src/components/DashboardOverview.tsx`) to guarantee:
 * 1. Immediate capital clearance on broker change.
 * 2. Out-of-order in-flight responses from prior brokers are discarded.
 * 3. Cross-broker data source mismatches fail closed.
 * 4. Network and authentication failures fail closed without polluting newer state.
 */
async function runPhase6c1RaceTestSuite() {
  console.log('================================================================');
  console.log('MonkTrades Phase 6C.3: Production Capital State & Race Test Suite');
  console.log('================================================================\n');

  // --------------------------------------------------------------------------
  // TEST 1: Strict DataSource & Broker Validation Unit Tests
  // --------------------------------------------------------------------------
  console.log('[Test 1] Production Payload DataSource & Broker Validation');
  {
    const validZerodhaLive: BrokerAccountCapital = {
      broker: 'zerodha',
      dataSource: 'ZERODHA_LIVE',
      connectionStatus: 'AUTHENTICATED',
      netBalance: 500000,
      availableCash: 500000,
      availableTradingMargin: 500000,
      utilizedMargin: 0,
      withdrawableFunds: null,
      currency: 'INR',
      asOf: new Date().toISOString(),
      isStale: false,
      isAfterHours: false,
      semanticNote: 'Valid Zerodha Live',
    };

    const validZerodhaMock: BrokerAccountCapital = {
      ...validZerodhaLive,
      dataSource: 'MOCK_DATA',
      semanticNote: 'Valid Zerodha Mock',
    };

    const validAngelOneLive: BrokerAccountCapital = {
      broker: 'angelone',
      dataSource: 'ANGELONE_LIVE',
      connectionStatus: 'AUTHENTICATED',
      netBalance: 300000,
      availableCash: 300000,
      availableTradingMargin: 300000,
      utilizedMargin: 0,
      withdrawableFunds: 300000,
      currency: 'INR',
      asOf: new Date().toISOString(),
      isStale: false,
      isAfterHours: false,
      semanticNote: 'Valid Angel One Live',
    };

    // Valid combinations
    assert.equal(validateBrokerCapitalPayload('zerodha', validZerodhaLive), true, 'Zerodha live must validate');
    assert.equal(validateBrokerCapitalPayload('zerodha', validZerodhaMock), true, 'Zerodha mock mode must validate');
    assert.equal(validateBrokerCapitalPayload('angelone', validAngelOneLive), true, 'Angel One live must validate');

    // Cross-broker invalid combinations (FAIL-CLOSED)
    assert.equal(validateBrokerCapitalPayload('zerodha', validAngelOneLive), false, 'Angel One data must not validate under Zerodha');
    assert.equal(validateBrokerCapitalPayload('angelone', validZerodhaLive), false, 'Zerodha data must not validate under Angel One');
    assert.equal(validateBrokerCapitalPayload('angelone', validZerodhaMock), false, 'Mock data must never validate under Angel One');
    assert.equal(validateBrokerCapitalPayload('zerodha', null), false, 'Null capital must not validate');
    assert.equal(validateBrokerCapitalPayload('angelone', null), false, 'Null capital must not validate');

    console.log('  ✓ PASSED: validateBrokerCapitalPayload correctly validates and rejects cross-broker payloads');
  }

  // --------------------------------------------------------------------------
  // TEST 2: Immediate Capital Clearance on Broker Switch
  // --------------------------------------------------------------------------
  console.log('\n[Test 2] Immediate Capital Clearance on Broker Switch');
  {
    const stateManager = new BrokerCapitalStateManager();
    const initialReq = stateManager.prepareFetch('zerodha');

    stateManager.applyCapitalSuccess(initialReq, 'zerodha', {
      broker: 'zerodha',
      dataSource: 'ZERODHA_LIVE',
      connectionStatus: 'AUTHENTICATED',
      netBalance: 500000,
      availableCash: 500000,
      availableTradingMargin: 500000,
      utilizedMargin: 0,
      withdrawableFunds: null,
      currency: 'INR',
      asOf: new Date().toISOString(),
      isStale: false,
      isAfterHours: false,
      semanticNote: 'Initial Zerodha capital',
    });

    assert.ok(stateManager.getCapital() !== null, 'Capital should initially be populated');

    // Switch broker
    const switchResult = stateManager.handleSelectBroker('angelone');

    assert.equal(switchResult.capital, null, 'Switch returns null capital');
    assert.equal(switchResult.loading, true, 'Switch initiates loading');
    assert.equal(stateManager.getCapital(), null, 'Current state capital must immediately be null');
    assert.equal(stateManager.isLoading(), true, 'Current state loading must be true');
    assert.equal(stateManager.getActiveBroker(), 'angelone', 'Active broker updated to angelone');
    console.log('  ✓ PASSED: Capital immediately cleared to null and loading set to true on switch');
  }

  // --------------------------------------------------------------------------
  // TEST 3: Out-of-Order In-Flight Response Discarded
  // --------------------------------------------------------------------------
  console.log('\n[Test 3] Out-of-Order In-Flight Response Discarded');
  {
    const stateManager = new BrokerCapitalStateManager();

    // 1. Slow Zerodha request initiated
    const req1 = stateManager.prepareFetch('zerodha');

    // Simulate async in-flight delay for Zerodha (takes 80ms)
    const slowZerodhaPromise = new Promise<{ reqId: number; data: BrokerAccountCapital }>((resolve) => {
      setTimeout(() => {
        resolve({
          reqId: req1,
          data: {
            broker: 'zerodha',
            dataSource: 'ZERODHA_LIVE',
            connectionStatus: 'AUTHENTICATED',
            netBalance: 250000,
            availableCash: 250000,
            availableTradingMargin: 250000,
            utilizedMargin: 0,
            withdrawableFunds: null,
            currency: 'INR',
            asOf: new Date().toISOString(),
            isStale: false,
            isAfterHours: false,
            semanticNote: 'Slow Zerodha response',
          },
        });
      }, 80);
    });

    // 2. User immediately switches to Angel One at 10ms
    await new Promise((r) => setTimeout(r, 10));
    stateManager.handleSelectBroker('angelone');

    // 3. Fast Angel One request dispatched (takes 20ms)
    const req2 = stateManager.prepareFetch('angelone');
    const fastAngelPromise = new Promise<{ reqId: number; data: BrokerAccountCapital }>((resolve) => {
      setTimeout(() => {
        resolve({
          reqId: req2,
          data: {
            broker: 'angelone',
            dataSource: 'ANGELONE_LIVE',
            connectionStatus: 'AUTHENTICATED',
            netBalance: 120000,
            availableCash: 120000,
            availableTradingMargin: 120000,
            utilizedMargin: 0,
            withdrawableFunds: 120000,
            currency: 'INR',
            asOf: new Date().toISOString(),
            isStale: false,
            isAfterHours: false,
            semanticNote: 'Fast Angel One response',
          },
        });
      }, 20);
    });

    // Fast Angel One resolves first (at ~30ms total)
    const angelRes = await fastAngelPromise;
    const angelApply = stateManager.applyCapitalSuccess(angelRes.reqId, 'angelone', angelRes.data);
    stateManager.finalizeFetch(angelRes.reqId, 'angelone');

    assert.equal(angelApply.accepted, true, 'Angel One response accepted');
    assert.equal(stateManager.getCapital()?.netBalance, 120000, 'State reflects Angel One balance');
    assert.equal(stateManager.isLoading(), false, 'Loading finalized for active request');

    // Slow Zerodha resolves later (at ~80ms total)
    const zerodhaRes = await slowZerodhaPromise;
    const zerodhaApply = stateManager.applyCapitalSuccess(zerodhaRes.reqId, 'zerodha', zerodhaRes.data);
    stateManager.finalizeFetch(zerodhaRes.reqId, 'zerodha');

    assert.equal(zerodhaApply.accepted, false, 'Late Zerodha response must be safely discarded');
    assert.equal(stateManager.getCapital()?.broker, 'angelone', 'Broker must remain angelone');
    assert.equal(stateManager.getCapital()?.netBalance, 120000, 'Balance must remain Angel One balance (120000), not overwritten by 250000');
    console.log('  ✓ PASSED: Out-of-order in-flight Zerodha response safely discarded');
  }

  // --------------------------------------------------------------------------
  // TEST 4: Late Error Does Not Overwrite Newer State
  // --------------------------------------------------------------------------
  console.log('\n[Test 4] Late Failure Does Not Clear Newer State');
  {
    const stateManager = new BrokerCapitalStateManager();

    const oldReq = stateManager.prepareFetch('zerodha');

    // Switch to angelone
    stateManager.handleSelectBroker('angelone');
    const newReq = stateManager.prepareFetch('angelone');

    // New request succeeds
    stateManager.applyCapitalSuccess(newReq, 'angelone', {
      broker: 'angelone',
      dataSource: 'ANGELONE_LIVE',
      connectionStatus: 'AUTHENTICATED',
      netBalance: 90000,
      availableCash: 90000,
      availableTradingMargin: 90000,
      utilizedMargin: 0,
      withdrawableFunds: 90000,
      currency: 'INR',
      asOf: new Date().toISOString(),
      isStale: false,
      isAfterHours: false,
      semanticNote: 'Active Angel One',
    });

    // Old failing request returns later
    const failRes = stateManager.applyCapitalFailure(oldReq, 'zerodha');
    assert.equal(failRes.accepted, false, 'Stale failure must not be accepted');
    assert.ok(stateManager.getCapital() !== null, 'Capital must not be cleared by old failure');
    assert.equal(stateManager.getCapital()?.netBalance, 90000, 'Capital balance preserved');
    console.log('  ✓ PASSED: Late failure from previous broker does NOT overwrite newer state');
  }

  // --------------------------------------------------------------------------
  // TEST 5: Active Failure Clears Capital Fail-Closed
  // --------------------------------------------------------------------------
  console.log('\n[Test 5] Active Failure Clears Capital Fail-Closed');
  {
    const stateManager = new BrokerCapitalStateManager();
    const req = stateManager.prepareFetch('zerodha');

    stateManager.applyCapitalSuccess(req, 'zerodha', {
      broker: 'zerodha',
      dataSource: 'ZERODHA_LIVE',
      connectionStatus: 'AUTHENTICATED',
      netBalance: 50000,
      availableCash: 50000,
      availableTradingMargin: 50000,
      utilizedMargin: 0,
      withdrawableFunds: null,
      currency: 'INR',
      asOf: new Date().toISOString(),
      isStale: false,
      isAfterHours: false,
      semanticNote: 'Active Zerodha',
    });

    // A refresh fails
    const refreshReq = stateManager.prepareFetch('zerodha');
    const failRes = stateManager.applyCapitalFailure(refreshReq, 'zerodha');
    stateManager.finalizeFetch(refreshReq, 'zerodha');

    assert.equal(failRes.accepted, true, 'Active failure accepted');
    assert.equal(stateManager.getCapital(), null, 'Capital cleared to null fail-closed');
    assert.equal(stateManager.isLoading(), false, 'Loading finalized');
    console.log('  ✓ PASSED: Active failure clears capital to null fail-closed');
  }

  console.log('\n================================================================');
  console.log('ALL PHASE 6C.3 CAPITAL STATE & RACE TESTS PASSED (5/5)');
  console.log('================================================================\n');
}

runPhase6c1RaceTestSuite().catch((err) => {
  console.error('Phase 6C.3 Race Test Suite Failed:', err);
  process.exit(1);
});
