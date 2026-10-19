import { strict as assert } from 'assert';
import { ServerRiskStore, DEFAULT_ACCOUNT_ID, DEFAULT_ANGELONE_ACCOUNT_ID } from '../server/risk/store';
import { RiskEngine, RiskSession } from '../server/risk/engine';
import { enableMockStoreForTesting, setAdminFirestoreForTesting } from '../server/brokers/zerodha/sessionStore';
import { RiskEvent, RiskEventType } from '../src/types/events';
import { getAccountDisplayName, getEventTypeTitle } from '../src/components/RiskEventsPanel';

console.log('================================================================');
console.log('MONKTRADES PHASE 9C: OPERATIONAL MONITORING & ALERTING SUITE');
console.log('Structured Events, Deduplication, Isolation & Sanitization');
console.log('================================================================');

async function runPhase9cTests() {
  enableMockStoreForTesting();
  ServerRiskStore.reset();

  const userId = 'user_phase9c_tester';
  const angelAccountId = DEFAULT_ANGELONE_ACCOUNT_ID;
  const zerodhaAccountId = DEFAULT_ACCOUNT_ID;

  // ------------------------------------------------------------------
  // TEST 1: All Event Types and Severities Generation & Sanitization
  // ------------------------------------------------------------------
  console.log('\nTEST 1: Event Types, Severities & Secret Sanitization');

  // Record an event with sensitive payload
  ServerRiskStore.recordEvent(userId, {
    accountId: angelAccountId,
    broker: 'angelone',
    type: 'BROKER_DISCONNECTED',
    severity: 'warning',
    message: 'Angel One session disconnected due to token expiration',
    idempotencyKey: `${angelAccountId}__2026-10-16__TEST_DISCONNECT`,
    details: {
      client_id: 'A12345',
      jwtToken: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.secret_payload',
      apiKey: 'secret_api_key_123',
      status: 'DISCONNECTED',
    },
  });

  const events = await ServerRiskStore.getAuditEvents(userId, angelAccountId, 50);
  assert.equal(events.length, 1, 'Should record exactly 1 event');
  const ev1 = events[0];
  assert.equal(ev1.type, 'BROKER_DISCONNECTED');
  assert.equal(ev1.severity, 'warning');
  assert.equal(ev1.accountId, angelAccountId);
  assert.equal(ev1.broker, 'angelone');
  assert.equal(ev1.details?.jwtToken, '[REDACTED]', 'jwtToken MUST be redacted');
  assert.equal(ev1.details?.apiKey, '[REDACTED]', 'apiKey MUST be redacted');
  assert.equal(ev1.details?.status, 'DISCONNECTED', 'Non-secret fields preserved');
  console.log('  ✓ PASSED: Events correctly recorded with safe diagnostic details & redacted secrets');

  // ------------------------------------------------------------------
  // TEST 2: Duplicate-Event Prevention & Idempotency
  // ------------------------------------------------------------------
  console.log('\nTEST 2: Duplicate-Event Prevention & Deterministic Idempotency');

  const duplicateKey = `${angelAccountId}__2026-10-16__TEST_DEDUP_KEY`;

  // Repeated calls with identical idempotencyKey
  for (let i = 0; i < 5; i++) {
    ServerRiskStore.recordEvent(userId, {
      accountId: angelAccountId,
      type: 'RISK_WARNING_70',
      severity: 'warning',
      message: 'Daily loss limit utilized 70%',
      idempotencyKey: duplicateKey,
    });
  }

  const angelEventsAfterDedup = await ServerRiskStore.getAuditEvents(userId, angelAccountId, 50);
  const dedupMatches = angelEventsAfterDedup.filter((e) => e.idempotencyKey === duplicateKey);
  assert.equal(dedupMatches.length, 1, 'Repeated calls with identical idempotencyKey MUST produce exactly 1 event');
  console.log('  ✓ PASSED: Duplicate evaluations correctly suppressed by deterministic idempotency key');

  // ------------------------------------------------------------------
  // TEST 3: Concurrent Evaluation Deduplication
  // ------------------------------------------------------------------
  console.log('\nTEST 3: Concurrent Evaluation Event Deduplication');

  const concurrentKey = `${angelAccountId}__2026-10-16__CONCURRENT_BREACH`;

  // Simulate parallel evaluation calls
  await Promise.all(
    Array.from({ length: 10 }).map(() =>
      Promise.resolve().then(() => {
        ServerRiskStore.recordEvent(userId, {
          accountId: angelAccountId,
          type: 'LOSS_LIMIT_BREACHED',
          severity: 'critical',
          message: 'Concurrent breach test',
          idempotencyKey: concurrentKey,
        });
      })
    )
  );

  const concurrentEvents = await ServerRiskStore.getAuditEvents(userId, angelAccountId, 50);
  const concurrentMatches = concurrentEvents.filter((e) => e.idempotencyKey === concurrentKey);
  assert.equal(concurrentMatches.length, 1, 'Concurrent requests with same idempotencyKey MUST produce exactly 1 event');
  console.log('  ✓ PASSED: Concurrent evaluations safely deduplicated');

  // ------------------------------------------------------------------
  // TEST 4: Full State Machine Transition Trail (Warning -> Breach -> Relock -> Reset)
  // ------------------------------------------------------------------
  console.log('\nTEST 4: State Machine Transition Trail & Persistent Breach Relock');

  const config = {
    dailyLossLimit: 10000,
    warningThreshold1: 70,
    warningThreshold2: 90,
    lockDurationMinutes: 720,
    lockDurationType: 'FIXED' as const,
    includeRealisedPnl: true,
    includeUnrealisedPnl: true,
    executionMode: 'ENFORCE' as const,
    accountId: angelAccountId,
    broker: 'angelone' as const,
    enabled: true,
  };

  const createMockPnl = (pnl: number) => ({
    tradingDate: '2026-10-16',
    grossTradingPnl: pnl,
    realisedPnl: pnl,
    unrealisedPnl: 0,
    dailyRealisedPnl: pnl,
    dailyUnrealisedPnl: 0,
    includedRealisedPnl: pnl,
    includedUnrealisedPnl: 0,
    fnoPositionCount: 1,
    totalPositionCount: 1,
    totalPnl: pnl,
    positions: [],
    source: 'ANGELONE_LIVE' as const,
    calculatedAt: new Date().toISOString(),
  });

  const evalTime0 = new Date('2026-10-16T10:00:00.000Z');

  // Step 4.1: Warning 70%
  const res1 = RiskEngine.evaluate({
    userId,
    config,
    pnlResult: createMockPnl(-7500),
    evaluationTime: evalTime0,
  });

  assert.equal(res1.state, 'WARNING');
  assert.equal(res1.transitionEvents.length, 1);
  assert.equal(res1.transitionEvents[0].type, 'RISK_WARNING_70');
  for (const ev of res1.transitionEvents) {
    ServerRiskStore.recordEvent(userId, ev);
  }

  // Step 4.2: Loss Limit Breach -> LOCKED (10,000 breach)
  const res2 = RiskEngine.evaluate({
    userId,
    config,
    pnlResult: createMockPnl(-10500),
    evaluationTime: evalTime0,
    currentSession: res1.session,
  });

  assert.equal(res2.state, 'LOCKED');
  assert.equal(res2.isBreached, true);
  assert.equal(res2.transitionEvents.length, 2, 'Should emit BREACH and LOCK_CREATED');
  assert.equal(res2.transitionEvents[0].type, 'LOSS_LIMIT_BREACHED');
  assert.equal(res2.transitionEvents[1].type, 'TRADING_LOCK_CREATED');
  for (const ev of res2.transitionEvents) {
    ServerRiskStore.recordEvent(userId, ev);
  }

  // Step 4.3: Lock Expiration at evalTime0 + 721m (while loss remains -10,500)
  const evalTimeExpired = new Date(evalTime0.getTime() + 721 * 60 * 1000);
  const res3 = RiskEngine.evaluate({
    userId,
    config,
    pnlResult: createMockPnl(-10500),
    evaluationTime: evalTimeExpired,
    currentSession: res2.session,
  });

  assert.equal(res3.state, 'LOCKED', 'Unresolved breach upon expiry MUST re-lock');
  assert.ok(
    res3.transitionEvents.some((e) => e.type === 'TRADING_LOCK_EXPIRED'),
    'Should emit TRADING_LOCK_EXPIRED'
  );
  assert.ok(
    res3.transitionEvents.some((e) => e.type === 'UNRESOLVED_BREACH_RELOCKED'),
    'Should emit UNRESOLVED_BREACH_RELOCKED'
  );

  for (const ev of res3.transitionEvents) {
    ServerRiskStore.recordEvent(userId, ev);
  }

  // Step 4.4: Authorized Reset
  await ServerRiskStore.resetSession(userId, angelAccountId);
  const eventsAfterReset = await ServerRiskStore.getAuditEvents(userId, angelAccountId, 50);
  assert.ok(
    eventsAfterReset.some((e) => e.type === 'AUTHORIZED_SESSION_RESET'),
    'Should emit AUTHORIZED_SESSION_RESET upon resetSession'
  );
  console.log('  ✓ PASSED: Warning -> Breach -> Lock Expired -> Relock -> Authorized Reset state transition sequence verified');

  // ------------------------------------------------------------------
  // TEST 5: Account Isolation (Angel One vs Zerodha Event Streams)
  // ------------------------------------------------------------------
  console.log('\nTEST 5: Account Event Isolation');

  ServerRiskStore.recordEvent(userId, {
    accountId: zerodhaAccountId,
    broker: 'zerodha',
    type: 'RISK_WARNING_70',
    severity: 'warning',
    message: 'Zerodha 70% threshold warning',
    idempotencyKey: `${zerodhaAccountId}__2026-10-16__ZERODHA_WARN`,
  });

  const angelOnlyEvents = await ServerRiskStore.getAuditEvents(userId, angelAccountId, 50);
  const zerodhaOnlyEvents = await ServerRiskStore.getAuditEvents(userId, zerodhaAccountId, 50);

  assert.ok(
    angelOnlyEvents.every((e) => e.accountId === angelAccountId),
    'Angel One event query MUST return ONLY Angel One events'
  );
  assert.ok(
    zerodhaOnlyEvents.every((e) => e.accountId === zerodhaAccountId),
    'Zerodha event query MUST return ONLY Zerodha events'
  );
  assert.ok(
    !angelOnlyEvents.some((e) => e.message.includes('Zerodha')),
    'Angel One event log must not contain Zerodha events'
  );
  console.log('  ✓ PASSED: Angel One and Zerodha event streams are strictly account-isolated');

  // ------------------------------------------------------------------
  // TEST 6: UI Display Helpers Verification
  // ------------------------------------------------------------------
  console.log('\nTEST 6: UI Display & Account Label Formatting Helpers');

  assert.equal(getAccountDisplayName('acc_mt_angelone_default', 'angelone'), 'Angel One (Default)');
  assert.equal(getAccountDisplayName('acc_mt_zerodha_default', 'zerodha'), 'Zerodha (Default)');
  assert.equal(getAccountDisplayName('acc_custom_account', 'zerodha'), 'Custom account');

  assert.equal(getEventTypeTitle('RISK_WARNING_70'), 'Risk Warning (70% Threshold)');
  assert.equal(getEventTypeTitle('LOSS_LIMIT_BREACHED'), 'Daily Loss Limit Breached');
  assert.equal(getEventTypeTitle('UNRESOLVED_BREACH_RELOCKED'), 'Unresolved Loss Breach Re-Locked');
  assert.equal(getEventTypeTitle('AUTHORIZED_SESSION_RESET'), 'Authorized Operator Reset');
  console.log('  ✓ PASSED: UI label helpers format friendly human-readable titles without raw internal account IDs');

  console.log('\n================================================================');
  console.log('PHASE 9C TEST SUITE COMPLETE: ALL 6 TESTS PASSED');
  console.log('================================================================\n');
}

runPhase9cTests().catch((err) => {
  console.error('Phase 9C Test Suite Failed:', err);
  process.exit(1);
});
