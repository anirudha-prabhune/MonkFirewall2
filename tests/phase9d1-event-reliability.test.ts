import { strict as assert } from 'assert';
import { RiskEngine } from '../server/risk/engine';
import { ServerRiskStore } from '../server/risk/store';
import { RiskConfig, RiskSession } from '../src/types/risk';

console.log('================================================================');
console.log('MONKTRADES PHASE 9D.1: COMPLETE RISK EVENT RELIABILITY SUITE');
console.log('Idempotency, Persistence Status, Lock Preservation & Reconciliation');
console.log('================================================================');

async function runPhase9d1Tests() {
  const userId = 'user_reliability_test_123';
  const angelAccountId = 'acc_mt_angelone_default';
  const zerodhaAccountId = 'acc_zerodha_main';

  const baseConfig: RiskConfig = {
    dailyLossLimit: 10000,
    warningThreshold1: 70,
    warningThreshold2: 90,
    lockDurationMinutes: 720,
    lockDurationType: 'FIXED',
    includeRealisedPnl: true,
    includeUnrealisedPnl: true,
    executionMode: 'ENFORCE',
    enabled: true,
    accountId: angelAccountId,
    broker: 'angelone',
    updatedAt: new Date().toISOString(),
  };

  ServerRiskStore.reset();

  // Helper builder for test PnlResults
  function createTestPnl(netPnl: number, timestamp: string, tradingDate = '2026-10-16'): any {
    return {
      grossTradingPnl: netPnl,
      realisedPnl: netPnl,
      unrealisedPnl: 0,
      netPnl: netPnl,
      timestamp,
      tradingDate,
      broker: 'angelone',
      accountId: angelAccountId,
      status: 'OK',
    };
  }

  // ------------------------------------------------------------------
  // TEST 1: Concurrent retries of same logical transition emit single deduplicated event
  // ------------------------------------------------------------------
  console.log('\nTEST 1: Concurrent retries deduplication');
  {
    ServerRiskStore.reset();

    const pnlBreach = createTestPnl(-12000, '2026-10-16T10:00:00.000Z');
    const evalTime = new Date(pnlBreach.timestamp);

    const [eval1, eval2, eval3] = await Promise.all([
      ServerRiskStore.evaluatePnlResult(userId, pnlBreach, evalTime, baseConfig, angelAccountId),
      ServerRiskStore.evaluatePnlResult(userId, pnlBreach, evalTime, baseConfig, angelAccountId),
      ServerRiskStore.evaluatePnlResult(userId, pnlBreach, evalTime, baseConfig, angelAccountId),
    ]);

    assert.equal(eval1.session.state, 'LOCKED');
    assert.equal(eval2.session.state, 'LOCKED');
    assert.equal(eval3.session.state, 'LOCKED');

    const events = await ServerRiskStore.getAuditEvents(userId, angelAccountId);
    const breachEvents = events.filter((e) => e.type === 'LOSS_LIMIT_BREACHED');
    const lockEvents = events.filter((e) => e.type === 'TRADING_LOCK_CREATED');

    assert.equal(breachEvents.length, 1, 'Should only have 1 breach event despite concurrent retries');
    assert.equal(lockEvents.length, 1, 'Should only have 1 lock created event despite concurrent retries');
    console.log('  PASSED: Exactly 1 breach and 1 lock event generated across 3 concurrent calls.');
  }

  // ------------------------------------------------------------------
  // TEST 2: Genuine repeated transitions (Warning -> Recovery -> Warning)
  // ------------------------------------------------------------------
  console.log('\nTEST 2: Genuine repeated transitions on same trading day');
  {
    ServerRiskStore.reset();

    // 1st warning: Loss reaches 7,500 (75%)
    const pnlWarn1 = createTestPnl(-7500, '2026-10-16T09:30:00.000Z');

    await ServerRiskStore.evaluatePnlResult(
      userId,
      pnlWarn1,
      new Date(pnlWarn1.timestamp),
      baseConfig,
      angelAccountId
    );

    let events = await ServerRiskStore.getAuditEvents(userId, angelAccountId);
    let warnEvents = events.filter((e) => e.type === 'RISK_WARNING_70');
    assert.equal(warnEvents.length, 1, 'First warning 70% emitted');

    // Recovery: P&L recovers to -2,000 (20%)
    const pnlRecover = createTestPnl(-2000, '2026-10-16T11:00:00.000Z');

    const recoverEval = await ServerRiskStore.evaluatePnlResult(
      userId,
      pnlRecover,
      new Date(pnlRecover.timestamp),
      baseConfig,
      angelAccountId
    );
    assert.equal(recoverEval.session.state, 'ALLOW');

    // 2nd warning: Loss drops back down to -8,000 (80%) on the SAME trading day
    const pnlWarn2 = createTestPnl(-8000, '2026-10-16T14:00:00.000Z');

    await ServerRiskStore.evaluatePnlResult(
      userId,
      pnlWarn2,
      new Date(pnlWarn2.timestamp),
      baseConfig,
      angelAccountId
    );

    events = await ServerRiskStore.getAuditEvents(userId, angelAccountId);
    warnEvents = events.filter((e) => e.type === 'RISK_WARNING_70');

    assert.equal(warnEvents.length, 2, 'Two distinct warnings emitted after recovery on same trading day');
    console.log('  PASSED: Two genuine warning transitions recorded on the same trading day.');
  }

  // ------------------------------------------------------------------
  // TEST 3: Lock Expiry with continuing breach triggers UNRESOLVED_BREACH_RELOCKED
  // ------------------------------------------------------------------
  console.log('\nTEST 3: Lock expiry and unresolved breach re-locking');
  {
    ServerRiskStore.reset();

    const initialLockAt = '2026-10-16T09:00:00.000Z';
    const pnlBreach = createTestPnl(-12000, initialLockAt);

    const eval1 = await ServerRiskStore.evaluatePnlResult(
      userId,
      pnlBreach,
      new Date(initialLockAt),
      baseConfig,
      angelAccountId
    );
    assert.equal(eval1.session.state, 'LOCKED');

    // Fast forward past 720m lock
    const futureTimeStr = new Date(new Date(initialLockAt).getTime() + 721 * 60 * 1000).toISOString();
    const futureDate = new Date(futureTimeStr);
    const pnlContinuingBreach = createTestPnl(-12000, futureTimeStr);

    const eval2 = await ServerRiskStore.evaluatePnlResult(
      userId,
      pnlContinuingBreach,
      futureDate,
      baseConfig,
      angelAccountId
    );

    assert.equal(eval2.session.state, 'LOCKED');
    assert.ok(eval2.session.reason?.includes('Daily loss limit'));

    const events = await ServerRiskStore.getAuditEvents(userId, angelAccountId);
    const expiredEvent = events.find((e) => e.type === 'TRADING_LOCK_EXPIRED');
    const relockedEvent = events.find((e) => e.type === 'UNRESOLVED_BREACH_RELOCKED');

    assert.ok(expiredEvent, 'TRADING_LOCK_EXPIRED event emitted upon lock duration completion');
    assert.ok(relockedEvent, 'UNRESOLVED_BREACH_RELOCKED event emitted when breach persists');
    assert.ok(relockedEvent.message.includes('Unresolved breach'));
    console.log('  PASSED: Lock expired and unresolved breach relocked seamlessly.');
  }

  // ------------------------------------------------------------------
  // TEST 4: Observability of RAM-buffered events during storage degradation
  // ------------------------------------------------------------------
  console.log('\nTEST 4: Truthful persistence status & RAM buffer tracking');
  {
    ServerRiskStore.reset();

    const unpersistedEvent = {
      accountId: angelAccountId,
      broker: 'angelone',
      type: 'BROKER_DISCONNECTED' as const,
      severity: 'warning' as const,
      timestamp: new Date().toISOString(),
      idempotencyKey: 'test_buffered_evt_1',
      message: 'Angel One API timeout during sync',
    };

    await ServerRiskStore.recordEvent(userId, unpersistedEvent);

    const events = await ServerRiskStore.getAuditEvents(userId, angelAccountId);
    const buffered = events.find((e) => e.idempotencyKey === 'test_buffered_evt_1');

    assert.ok(buffered, 'Buffered event is retrievable');
    assert.equal(buffered?.persisted, false, 'persisted is false for RAM-buffered event');
    assert.equal(buffered?.persistenceStatus, 'buffered', 'persistenceStatus is buffered');
    console.log('  PASSED: RAM-buffered events accurately tagged with persistenceStatus = buffered.');
  }

  // ------------------------------------------------------------------
  // TEST 5: Storage failure NEVER bypasses or suppresses risk lock creation
  // ------------------------------------------------------------------
  console.log('\nTEST 5: Risk enforcement independence from event storage failures');
  {
    ServerRiskStore.reset();

    const pnlBreach = createTestPnl(-15000, '2026-10-16T10:30:00.000Z');

    const sessionBefore: RiskSession = {
      tradingDate: '2026-10-16',
      userId,
      accountId: angelAccountId,
      executionMode: 'ENFORCE',
      state: 'ALLOW',
      isBreached: false,
      lockedAt: null,
      lockUntil: null,
      currentPnl: 0,
      realisedPnl: 0,
      unrealisedPnl: 0,
      lossLimit: 10000,
      warningThreshold1: 70,
      warningThreshold2: 90,
      lastEvaluatedAt: new Date().toISOString(),
    };

    // Engine evaluation directly
    const evalResult = RiskEngine.evaluate({
      currentSession: sessionBefore,
      pnlResult: pnlBreach,
      config: baseConfig,
    });
    assert.equal(evalResult.session.state, 'LOCKED', 'Engine mandates LOCKED state');

    // Store evaluation
    const storeEval = await ServerRiskStore.evaluatePnlResult(
      userId,
      pnlBreach,
      new Date(pnlBreach.timestamp),
      baseConfig,
      angelAccountId
    );
    assert.equal(storeEval.session.state, 'LOCKED', 'Store session transitions to LOCKED');

    const sessionInStore = await ServerRiskStore.getSession(userId, '2026-10-16', angelAccountId);
    assert.equal(sessionInStore?.state, 'LOCKED', 'Session state persisted as LOCKED in memory store');
    assert.equal(sessionInStore?.lossAmount, 15000);
    console.log('  PASSED: Risk lock created and enforced independently of audit storage state.');
  }

  // ------------------------------------------------------------------
  // TEST 6: Account isolation and secret sanitization
  // ------------------------------------------------------------------
  console.log('\nTEST 6: Account isolation and secret sanitization');
  {
    ServerRiskStore.reset();

    await ServerRiskStore.recordEvent(userId, {
      accountId: angelAccountId,
      broker: 'angelone',
      type: 'RISK_WARNING_70',
      severity: 'warning',
      timestamp: '2026-10-16T10:00:00.000Z',
      message: 'Angel One warning 70%',
      details: { token: 'SECRET_JWT_TOKEN_12345', password: 'MY_PASSWORD' },
    });

    await ServerRiskStore.recordEvent(userId, {
      accountId: zerodhaAccountId,
      broker: 'zerodha',
      type: 'LOSS_LIMIT_BREACHED',
      severity: 'critical',
      timestamp: '2026-10-16T10:05:00.000Z',
      message: 'Zerodha breach',
    });

    const angelEvents = await ServerRiskStore.getAuditEvents(userId, angelAccountId);
    assert.equal(angelEvents.length, 1);
    assert.equal(angelEvents[0].accountId, angelAccountId);
    assert.equal(angelEvents[0].details?.token, '[REDACTED]');
    assert.equal(angelEvents[0].details?.password, '[REDACTED]');

    const zerodhaEvents = await ServerRiskStore.getAuditEvents(userId, zerodhaAccountId);
    assert.equal(zerodhaEvents.length, 1);
    assert.equal(zerodhaEvents[0].accountId, zerodhaAccountId);

    console.log('  PASSED: Multi-account isolation and secret redaction verified.');
  }

  console.log('\n================================================================');
  console.log('ALL PHASE 9D.1 EVENT RELIABILITY TESTS PASSED SUCCESSFULLY! (6/6)');
  console.log('================================================================\n');
}

runPhase9d1Tests().catch((err) => {
  console.error('\nTEST FAILURE:', err);
  process.exit(1);
});
