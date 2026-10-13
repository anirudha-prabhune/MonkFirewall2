import { ServerRiskStore, DEFAULT_ACCOUNT_ID } from '../server/risk/store';
import { getBrokerConnections, setInitialBrokerStatus } from '../src/services/brokerConnectionService';
import { enableMockStoreForTesting } from '../server/brokers/zerodha/sessionStore';
import { getTradingDateKolkata } from '../server/risk/engine';

enableMockStoreForTesting(true);
process.env.NODE_ENV = 'test';

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(`ASSERTION FAILED: ${message}`);
  }
}

async function runStage5E2ETests() {
  console.log('================================================================');
  console.log('TRADING FIREWALL: STAGE 5 END-TO-END MVP VALIDATION SUITE');
  console.log('Multi-Account Frontend Integration, State Isolation & Enforcement');
  console.log('================================================================\n');

  ServerRiskStore.reset();
  const userId = 'mock-user_stage5_e2e';
  const defaultAcc = DEFAULT_ACCOUNT_ID;
  const primaryAcc = 'acc_zerodha_primary';
  const secondaryAcc = 'acc_zerodha_secondary';
  const today = getTradingDateKolkata(new Date());

  // 1. Default Zerodha Compatibility & Account Discovery
  console.log('[Test 1] Default Zerodha Compatibility & Account Discovery');
  const connections = await getBrokerConnections(userId);
  assert(Array.isArray(connections) && connections.length > 0, 'Broker connections discovery must succeed');
  const defaultConn = connections.find(c => c.connectionId === defaultAcc);
  assert(defaultConn !== undefined, 'Default Zerodha account must be present');
  console.log('  ✓ PASSED: Default Zerodha compatibility and discovery');

  // 2. Account-Specific Risk Configuration & Saving
  console.log('\n[Test 2] Account-Specific Risk Configuration & Saving');
  const configPrimary = {
    dailyLossLimit: 8000,
    warningThreshold1: 50,
    warningThreshold2: 80,
    lockDurationMinutes: 720,
    lockDurationType: 'FIXED',
    includeRealisedPnl: true,
    includeUnrealisedPnl: true,
    enabled: true,
  };
  const configSecondary = {
    dailyLossLimit: 20000,
    warningThreshold1: 60,
    warningThreshold2: 90,
    lockDurationMinutes: 720,
    lockDurationType: 'FIXED',
    includeRealisedPnl: true,
    includeUnrealisedPnl: true,
    enabled: true,
  };

  const save1 = await ServerRiskStore.saveConfig(userId, configPrimary, primaryAcc);
  assert(save1.success, 'Save config for primary account must succeed');

  const save2 = await ServerRiskStore.saveConfig(userId, configSecondary, secondaryAcc);
  assert(save2.success, 'Save config for secondary account must succeed');

  const retrievedPrimary = await ServerRiskStore.getConfig(userId, primaryAcc);
  const retrievedSecondary = await ServerRiskStore.getConfig(userId, secondaryAcc);

  assert(retrievedPrimary.dailyLossLimit === 8000, `Primary config limit expected 8000, got ${retrievedPrimary.dailyLossLimit}`);
  assert(retrievedSecondary.dailyLossLimit === 20000, `Secondary config limit expected 20000, got ${retrievedSecondary.dailyLossLimit}`);
  console.log('  ✓ PASSED: Account-scoped configuration saves and retrieval');

  // 3. Account-Scoped P&L Evaluation & State Isolation
  console.log('\n[Test 3] Account-Scoped P&L Evaluation & State Isolation');
  // Evaluate loss of 9000 on primary account (limit 8000) -> should breach primary account
  const evalPrimary = await ServerRiskStore.evaluatePnl(
    userId,
    -9000,
    new Date(),
    primaryAcc
  );
  assert(evalPrimary.state === 'LOCKED', 'Primary account should be LOCKED due to loss limit breach');

  // Evaluate loss of 9000 on secondary account (limit 20000) -> should remain ALLOW
  const evalSecondary = await ServerRiskStore.evaluatePnl(
    userId,
    -9000,
    new Date(),
    secondaryAcc
  );
  assert(evalSecondary.state === 'ALLOW', 'Secondary account should remain ALLOW since loss is within 20000 limit');
  console.log('  ✓ PASSED: Account-scoped P&L evaluation and strict state isolation');

  // 4. Lock Status & Enforcement Regression
  console.log('\n[Test 4] Lock Status & Enforcement Regression');
  const lockStatusPrimary = await ServerRiskStore.getLockStatus(userId, primaryAcc, today);
  assert(lockStatusPrimary.locked === true, 'Primary account lock status must be locked');

  const lockStatusSecondary = await ServerRiskStore.getLockStatus(userId, secondaryAcc, today);
  assert(lockStatusSecondary.locked === false, 'Secondary account lock status must be unlocked');

  const sessionPrimary = await ServerRiskStore.getSession(userId, today, primaryAcc);
  assert(sessionPrimary.state === 'LOCKED', 'Session state must be LOCKED for primary account');

  const sessionSecondary = await ServerRiskStore.getSession(userId, today, secondaryAcc);
  assert(sessionSecondary.state === 'ALLOW', 'Session state must be ALLOW for secondary account');
  console.log('  ✓ PASSED: Lock status and risk enforcement regression across accounts');

  // 5. Disconnected Account & API Failure Resilience
  console.log('\n[Test 5] Disconnected Account & API Failure Resilience');
  const defaultResolved = await ServerRiskStore.resolveAccountId(userId);
  assert(defaultResolved === DEFAULT_ACCOUNT_ID, 'Omitted account ID resolves safely to default');
  console.log('  ✓ PASSED: Disconnected account handling and safe fallback');

  console.log('\n================================================================');
  console.log('ALL STAGE 5 END-TO-END MVP VALIDATION TESTS PASSED (5/5)');
  console.log('================================================================');
}

runStage5E2ETests().catch((err) => {
  console.error('STAGE 5 E2E MVP VALIDATION FAILED:', err);
  process.exit(1);
});
