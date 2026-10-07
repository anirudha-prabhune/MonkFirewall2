import { strict as assert } from 'assert';
import {
  LiveRiskRecorder,
  getLiveRiskStateRecordingEnabled,
  setLiveRiskStateRecordingEnabled,
  resetRecordingStates,
} from '../server/risk/liveRiskRecorder';
import { ActivationGuardService } from '../server/risk/activationGuard';
import { ServerRiskStore } from '../server/risk/store';
import { RawBrokerPosition, BrokerInstrument } from '../server/brokers/types';
import { RiskConfig } from '../src/types/risk';
import { BrokerService } from '../server/brokers/service';
import { MarketDataService } from '../server/market/marketDataService';
import { ZerodhaCredentialManager } from '../server/brokers/zerodha/credentials';
import { enableMockStoreForTesting, ZerodhaSessionStore } from '../server/brokers/zerodha/sessionStore';
import { LiveZerodhaAdapter } from '../server/brokers/zerodha/liveAdapter';

async function runLiveRiskSafetyGatingTestSuite() {
  console.log('================================================================');
  console.log('TRADING FIREWALL: PHASE 13 LIVE-RISK SAFETY GATING SUITE');
  console.log('Rigorous Validation Gate Enforcement & Cross-User Isolation');
  console.log('================================================================\n');

  enableMockStoreForTesting(true);
  resetRecordingStates();
  ServerRiskStore.reset();

  const userA = 'safety_test_user_a';
  const userB = 'safety_test_user_b';

  const testInstrumentMap = new Map<number, BrokerInstrument>([
    [
      10418946,
      {
        instrumentToken: 10418946,
        tradingsymbol: 'NIFTY26O0622550CE',
        name: 'NIFTY',
        expiry: '2026-10-06',
        strike: 22550,
        tickSize: 0.05,
        lotSize: 65,
        instrumentType: 'CE',
        segment: 'NFO-OPT',
        exchange: 'NFO',
      },
    ],
    [
      10419202,
      {
        instrumentToken: 10419202,
        tradingsymbol: 'NIFTY26O0622550PE',
        name: 'NIFTY',
        expiry: '2026-10-06',
        strike: 22550,
        tickSize: 0.05,
        lotSize: 65,
        instrumentType: 'PE',
        segment: 'NFO-OPT',
        exchange: 'NFO',
      },
    ],
  ]);

  const testConfig: RiskConfig = {
    dailyLossLimit: 5000,
    warningThreshold1: 70,
    warningThreshold2: 85,
    lockDurationMinutes: 120,
    lockDurationType: 'FIXED',
    includeRealisedPnl: true,
    includeUnrealisedPnl: true,
    enabled: true,
  };

  await ServerRiskStore.saveConfig(userA, testConfig);
  await ServerRiskStore.saveConfig(userB, testConfig);

  // Setup live market ticks for valid tests
  MarketDataService.reset();
  MarketDataService.connect();
  MarketDataService.ingestTick(10418946, 79.5, new Date());
  MarketDataService.ingestTick(10419202, 74.15, new Date());

  const validPositions: RawBrokerPosition[] = [
    {
      tradingsymbol: 'NIFTY26O0622550CE',
      exchange: 'NFO',
      instrument_token: 10418946,
      product: 'NRML',
      quantity: 65,
      overnight_quantity: 0,
      multiplier: 1,
      average_price: 100,
      close_price: 100,
      last_price: 79.5,
      pnl: -1332.5,
      m2m: -1332.5,
      unrealised: -1332.5,
      realised: 0,
      day_buy_quantity: 65,
      day_buy_value: 6500,
      day_sell_quantity: 0,
      day_sell_value: 0,
    },
  ];

  try {
    // --------------------------------------------------------------------------
    // TEST 1: VALID validationState allows authoritative live RiskSession recording
    // --------------------------------------------------------------------------
    console.log('[Test 1] VALID state allows authoritative RiskSession recording when enabled');
    setLiveRiskStateRecordingEnabled(true, userA);
    assert.equal(getLiveRiskStateRecordingEnabled(userA), true, 'Recording enabled for user A');

    const resValid = await LiveRiskRecorder.evaluateAndRecordLiveRisk(userA, {
      injectedPositions: validPositions,
      injectedInstrumentMap: testInstrumentMap,
      configOverride: testConfig,
    });

    assert.equal(resValid.validationResult.validationState, 'VALID', 'Validation state is VALID');
    assert.equal(resValid.recorded, true, 'recorded is true for VALID state');
    assert.equal(resValid.state, 'ALLOW', 'State is ALLOW');
    assert.equal(resValid.grossTradingPnl, -1332.5, 'Gross trading P&L recorded correctly');

    const sessionA = await ServerRiskStore.getSession(userA);
    assert.equal(sessionA.currentPnl, -1332.5, 'RiskSession persisted to store');
    console.log('  ✓ PASSED: VALID state successfully persists to authoritative RiskSession');

    // --------------------------------------------------------------------------
    // TEST 2: STALE_DATA is strictly blocked from authoritative persistence
    // --------------------------------------------------------------------------
    console.log('\n[Test 2] STALE_DATA is strictly blocked from authoritative persistence');
    const sessionBeforeStale = JSON.stringify(await ServerRiskStore.getSession(userA));
    const eventsBeforeStale = (await ServerRiskStore.getAuditEvents(userA)).length;

    // Simulate stale market data (tick older than threshold)
    MarketDataService.setStaleThresholdSeconds(10);
    const staleTime = new Date(Date.now() - 60000); // 60s ago
    MarketDataService.ingestTick(10418946, 79.5, staleTime);

    const resStale = await LiveRiskRecorder.evaluateAndRecordLiveRisk(userA, {
      injectedPositions: validPositions,
      injectedInstrumentMap: testInstrumentMap,
      configOverride: testConfig,
    });

    assert.equal(resStale.validationResult.validationState, 'STALE_DATA', 'Validation state is STALE_DATA');
    assert.equal(resStale.recorded, false, 'recorded is false for STALE_DATA');
    assert(resStale.reason?.includes('STALE_DATA') || resStale.reason?.includes('stale'), 'Rejection reason documented');

    const sessionAfterStale = JSON.stringify(await ServerRiskStore.getSession(userA));
    const eventsAfterStale = (await ServerRiskStore.getAuditEvents(userA)).length;
    assert.equal(sessionAfterStale, sessionBeforeStale, 'RiskSession 100% unmutated on STALE_DATA');
    assert.equal(eventsAfterStale, eventsBeforeStale, 'Zero riskEvents written on STALE_DATA');
    console.log('  ✓ PASSED: STALE_DATA rejected with zero mutations');

    // Restore fresh market data
    MarketDataService.setStaleThresholdSeconds(300);
    MarketDataService.ingestTick(10418946, 79.5, new Date());

    // --------------------------------------------------------------------------
    // TEST 3: MISSING_DATA is strictly blocked from authoritative persistence
    // --------------------------------------------------------------------------
    console.log('\n[Test 3] MISSING_DATA is strictly blocked from authoritative persistence');
    MarketDataService.reset();
    MarketDataService.connect();
    // Do NOT ingest tick for 10418946 -> missing LTP

    const sessionBeforeMissing = JSON.stringify(await ServerRiskStore.getSession(userA));
    const eventsBeforeMissing = (await ServerRiskStore.getAuditEvents(userA)).length;

    const resMissing = await LiveRiskRecorder.evaluateAndRecordLiveRisk(userA, {
      injectedPositions: validPositions,
      injectedInstrumentMap: testInstrumentMap,
      configOverride: testConfig,
    });

    assert.equal(resMissing.validationResult.validationState, 'MISSING_DATA', 'Validation state is MISSING_DATA');
    assert.equal(resMissing.recorded, false, 'recorded is false for MISSING_DATA');

    const sessionAfterMissing = JSON.stringify(await ServerRiskStore.getSession(userA));
    const eventsAfterMissing = (await ServerRiskStore.getAuditEvents(userA)).length;
    assert.equal(sessionAfterMissing, sessionBeforeMissing, 'RiskSession 100% unmutated on MISSING_DATA');
    assert.equal(eventsAfterMissing, eventsBeforeMissing, 'Zero riskEvents written on MISSING_DATA');
    console.log('  ✓ PASSED: MISSING_DATA rejected with zero mutations');

    // --------------------------------------------------------------------------
    // TEST 4: DISCREPANCY is strictly blocked from authoritative persistence
    // --------------------------------------------------------------------------
    console.log('\n[Test 4] DISCREPANCY is strictly blocked from authoritative persistence');
    MarketDataService.ingestTick(10418946, 79.5, new Date());

    const discrepancyPositions: RawBrokerPosition[] = [
      {
        ...validPositions[0],
        m2m: -5000, // Broker says -5000, calculation says -1332.5 (diff > tolerance)
        pnl: -5000,
        unrealised: -5000,
      },
    ];

    const sessionBeforeDisc = JSON.stringify(await ServerRiskStore.getSession(userA));
    const eventsBeforeDisc = (await ServerRiskStore.getAuditEvents(userA)).length;

    const resDisc = await LiveRiskRecorder.evaluateAndRecordLiveRisk(userA, {
      injectedPositions: discrepancyPositions,
      injectedInstrumentMap: testInstrumentMap,
      configOverride: testConfig,
    });

    assert.equal(resDisc.validationResult.validationState, 'DISCREPANCY', 'Validation state is DISCREPANCY');
    assert.equal(resDisc.recorded, false, 'recorded is false for DISCREPANCY');

    const sessionAfterDisc = JSON.stringify(await ServerRiskStore.getSession(userA));
    const eventsAfterDisc = (await ServerRiskStore.getAuditEvents(userA)).length;
    assert.equal(sessionAfterDisc, sessionBeforeDisc, 'RiskSession 100% unmutated on DISCREPANCY');
    assert.equal(eventsAfterDisc, eventsBeforeDisc, 'Zero riskEvents written on DISCREPANCY');
    console.log('  ✓ PASSED: DISCREPANCY rejected with zero mutations');

    // --------------------------------------------------------------------------
    // TEST 5: UNKNOWN_INSTRUMENTS is strictly blocked from authoritative persistence
    // --------------------------------------------------------------------------
    console.log('\n[Test 5] UNKNOWN_INSTRUMENTS is strictly blocked from authoritative persistence');
    const unknownInstrumentPositions: RawBrokerPosition[] = [
      ...validPositions,
      {
        tradingsymbol: 'UNKNOWN_FNO_TOKEN',
        exchange: 'NFO',
        instrument_token: 99999999, // Unknown token
        product: 'NRML',
        quantity: 50,
        average_price: 100,
        last_price: 100,
        pnl: 0,
        m2m: 0,
        unrealised: 0,
        realised: 0,
        day_buy_quantity: 50,
        day_buy_value: 5000,
        day_sell_quantity: 0,
        day_sell_value: 0,
      },
    ];

    const sessionBeforeUnknown = JSON.stringify(await ServerRiskStore.getSession(userA));
    const eventsBeforeUnknown = (await ServerRiskStore.getAuditEvents(userA)).length;

    const resUnknown = await LiveRiskRecorder.evaluateAndRecordLiveRisk(userA, {
      injectedPositions: unknownInstrumentPositions,
      injectedInstrumentMap: testInstrumentMap,
      configOverride: testConfig,
    });

    assert.equal(resUnknown.validationResult.validationState, 'UNKNOWN_INSTRUMENTS', 'Validation state is UNKNOWN_INSTRUMENTS');
    assert.equal(resUnknown.recorded, false, 'recorded is false for UNKNOWN_INSTRUMENTS');

    const sessionAfterUnknown = JSON.stringify(await ServerRiskStore.getSession(userA));
    const eventsAfterUnknown = (await ServerRiskStore.getAuditEvents(userA)).length;
    assert.equal(sessionAfterUnknown, sessionBeforeUnknown, 'RiskSession 100% unmutated on UNKNOWN_INSTRUMENTS');
    assert.equal(eventsAfterUnknown, eventsBeforeUnknown, 'Zero riskEvents written on UNKNOWN_INSTRUMENTS');
    console.log('  ✓ PASSED: UNKNOWN_INSTRUMENTS rejected with zero mutations');

    // --------------------------------------------------------------------------
    // TEST 6: AUTHENTICATION_REQUIRED is strictly blocked from persistence
    // --------------------------------------------------------------------------
    console.log('\n[Test 6] AUTHENTICATION_REQUIRED is strictly blocked from persistence');
    await ZerodhaCredentialManager.disconnect(userA);

    const sessionBeforeAuth = JSON.stringify(await ServerRiskStore.getSession(userA));
    const eventsBeforeAuth = (await ServerRiskStore.getAuditEvents(userA)).length;

    const resAuth = await LiveRiskRecorder.evaluateAndRecordLiveRisk(userA, {
      configOverride: testConfig,
    });

    assert.equal(resAuth.validationResult.validationState, 'AUTHENTICATION_REQUIRED', 'Validation state is AUTHENTICATION_REQUIRED');
    assert.equal(resAuth.recorded, false, 'recorded is false for AUTHENTICATION_REQUIRED');

    const sessionAfterAuth = JSON.stringify(await ServerRiskStore.getSession(userA));
    const eventsAfterAuth = (await ServerRiskStore.getAuditEvents(userA)).length;
    assert.equal(sessionAfterAuth, sessionBeforeAuth, 'RiskSession 100% unmutated on AUTHENTICATION_REQUIRED');
    assert.equal(eventsAfterAuth, eventsBeforeAuth, 'Zero riskEvents written on AUTHENTICATION_REQUIRED');
    console.log('  ✓ PASSED: AUTHENTICATION_REQUIRED rejected with zero mutations');

    // --------------------------------------------------------------------------
    // TEST 7: ERROR state is strictly blocked from persistence
    // --------------------------------------------------------------------------
    console.log('\n[Test 7] ERROR state is strictly blocked from persistence');
    await ZerodhaSessionStore.saveSession(userA, 'test_token', { brokerUserId: 'ZU1234' });

    // Setup live adapter throwing network error
    const brokenFetch = async () => ({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      json: async () => ({ status: 'error', message: 'Zerodha server down' }),
    });
    BrokerService.getLiveAdapter().setFetchHandler(brokenFetch as any);

    const sessionBeforeErr = JSON.stringify(await ServerRiskStore.getSession(userA));
    const eventsBeforeErr = (await ServerRiskStore.getAuditEvents(userA)).length;

    const resErr = await LiveRiskRecorder.evaluateAndRecordLiveRisk(userA, {
      configOverride: testConfig,
    });

    assert.equal(resErr.validationResult.validationState, 'ERROR', 'Validation state is ERROR');
    assert.equal(resErr.recorded, false, 'recorded is false for ERROR');

    const sessionAfterErr = JSON.stringify(await ServerRiskStore.getSession(userA));
    const eventsAfterErr = (await ServerRiskStore.getAuditEvents(userA)).length;
    assert.equal(sessionAfterErr, sessionBeforeErr, 'RiskSession 100% unmutated on ERROR');
    assert.equal(eventsAfterErr, eventsBeforeErr, 'Zero riskEvents written on ERROR');
    console.log('  ✓ PASSED: ERROR state rejected with zero mutations');

    // --------------------------------------------------------------------------
    // TEST 8: Activation Preflight rejects STALE_DATA
    // --------------------------------------------------------------------------
    console.log('\n[Test 8] Activation preflight strictly rejects STALE_DATA with blockers');
    const validFetch = async (url: string) => {
      if (url.includes('/user/profile')) {
        return { ok: true, status: 200, json: async () => ({ status: 'success', data: { user_id: 'ZU1234' } }) };
      }
      if (url.includes('/portfolio/positions')) {
        return { ok: true, status: 200, json: async () => ({ status: 'success', data: { net: validPositions, day: [] } }) };
      }
      if (url.includes('/instruments')) {
        return { ok: true, status: 200, json: async () => Array.from(testInstrumentMap.values()) };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    };
    BrokerService.getLiveAdapter().setFetchHandler(validFetch as any);

    // Make market tick stale
    MarketDataService.setStaleThresholdSeconds(10);
    MarketDataService.ingestTick(10418946, 79.5, new Date(Date.now() - 60000));

    const preflightStale = await ActivationGuardService.evaluatePreflight(userA);
    assert.equal(preflightStale.ready, false, 'Preflight ready is false for stale data');
    assert.equal(preflightStale.livePnlValidated, false, 'livePnlValidated is false for stale data');
    assert(preflightStale.blockers.some((b) => b.includes('stale')), 'Blocker identifies stale market data');
    console.log('  ✓ PASSED: Activation preflight strictly rejects stale live data');

    // --------------------------------------------------------------------------
    // TEST 9: Never fabricate zero P&L when live data is unavailable
    // --------------------------------------------------------------------------
    console.log('\n[Test 9] Live recording never fabricates zero P&L when live data is unavailable');
    // Lock user A with an existing loss of ₹5,000
    const evalTime = new Date('2026-10-06T10:00:00.000Z');
    MarketDataService.setStaleThresholdSeconds(300);
    MarketDataService.ingestTick(10418946, 23.07, evalTime); // Large loss

    const lossPositions: RawBrokerPosition[] = [
      {
        ...validPositions[0],
        last_price: 23.07,
        pnl: -5000,
        m2m: -5000,
        unrealised: -5000,
      },
    ];

    const breachRes = await LiveRiskRecorder.evaluateAndRecordLiveRisk(userA, {
      injectedPositions: lossPositions,
      injectedInstrumentMap: testInstrumentMap,
      configOverride: testConfig,
      evaluationTime: evalTime,
    });
    assert.equal(breachRes.state, 'LOCKED', 'User A enters LOCKED state');

    // Now disconnect broker or corrupt market data so validation state becomes ERROR / MISSING_DATA
    await ZerodhaCredentialManager.disconnect(userA);
    const evalDuringDisconnect = await LiveRiskRecorder.evaluateAndRecordLiveRisk(userA, {
      configOverride: testConfig,
      evaluationTime: new Date('2026-10-06T10:15:00.000Z'),
    });

    assert.equal(evalDuringDisconnect.recorded, false, 'recorded is false during disconnection');
    assert.equal(evalDuringDisconnect.state, 'LOCKED', 'LOCKED state strictly preserved, NOT fabricated to ALLOW with 0 P&L');
    assert.equal(evalDuringDisconnect.isBreached, true, 'isBreached remains true');
    console.log('  ✓ PASSED: Disconnection never fabricates zero P&L or resets locked circuit breaker');

    // --------------------------------------------------------------------------
    // TEST 10: Cross-user recording isolation
    // --------------------------------------------------------------------------
    console.log('\n[Test 10] Cross-user recording isolation: User A enabled does NOT enable User B');
    resetRecordingStates();

    setLiveRiskStateRecordingEnabled(true, userA);
    assert.equal(getLiveRiskStateRecordingEnabled(userA), true, 'User A recording is true');
    assert.equal(getLiveRiskStateRecordingEnabled(userB), false, 'User B recording is strictly false');

    // Reconnect session for User B
    await ZerodhaSessionStore.saveSession(userB, 'token_b', { brokerUserId: 'ZU9999' });
    MarketDataService.ingestTick(10418946, 79.5, new Date());

    const sessionBBefore = JSON.stringify(await ServerRiskStore.getSession(userB));
    const eventsBBefore = (await ServerRiskStore.getAuditEvents(userB)).length;

    // Evaluate User B with profit positions
    const resUserB = await LiveRiskRecorder.evaluateAndRecordLiveRisk(userB, {
      injectedPositions: validPositions,
      injectedInstrumentMap: testInstrumentMap,
      configOverride: testConfig,
    });

    assert.equal(resUserB.recorded, false, 'User B evaluation recorded is strictly false (Shadow only)');
    assert.equal(resUserB.flagEnabled, false, 'User B flagEnabled is false');

    const sessionBAfter = JSON.stringify(await ServerRiskStore.getSession(userB));
    const eventsBAfter = (await ServerRiskStore.getAuditEvents(userB)).length;
    assert.equal(sessionBAfter, sessionBBefore, 'User B RiskSession remained completely untouched');
    assert.equal(eventsBAfter, eventsBBefore, 'Zero riskEvents written for User B');

    // Now evaluate User A -> User A records
    await ZerodhaSessionStore.saveSession(userA, 'token_a', { brokerUserId: 'ZU1234' });
    const resUserA = await LiveRiskRecorder.evaluateAndRecordLiveRisk(userA, {
      injectedPositions: validPositions,
      injectedInstrumentMap: testInstrumentMap,
      configOverride: testConfig,
    });
    assert.equal(resUserA.recorded, true, 'User A evaluation recorded is true');
    console.log('  ✓ PASSED: Strict cross-user recording isolation verified');

    // --------------------------------------------------------------------------
    // TEST 11: Safety boundary: Zero order APIs
    // --------------------------------------------------------------------------
    console.log('\n[Test 11] Safety boundary: Zero order/trading APIs exist');
    const adapter = new LiveZerodhaAdapter();
    assert.equal(typeof (adapter as any).placeOrder, 'undefined', 'No placeOrder');
    assert.equal(typeof (adapter as any).modifyOrder, 'undefined', 'No modifyOrder');
    assert.equal(typeof (adapter as any).cancelOrder, 'undefined', 'No cancelOrder');
    assert.equal(typeof (adapter as any).squareOff, 'undefined', 'No squareOff');
    console.log('  ✓ PASSED: Pure read-only safety boundary confirmed');
  } finally {
    resetRecordingStates();
  }

  console.log('\n================================================================');
  console.log('ALL PHASE 13 LIVE-RISK SAFETY GATING TESTS PASSED (11/11)');
  console.log('================================================================\n');
}

runLiveRiskSafetyGatingTestSuite().catch((err) => {
  console.error('Phase 13 Safety Gating Suite Error:', err);
  process.exit(1);
});
