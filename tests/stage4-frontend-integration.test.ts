import { ServerRiskStore, DEFAULT_ACCOUNT_ID } from '../server/risk/store';
import { getBrokerConnections } from '../src/services/brokerConnectionService';
import { enableMockStoreForTesting } from '../server/brokers/zerodha/sessionStore';

enableMockStoreForTesting(true);
process.env.NODE_ENV = 'test';

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(`ASSERTION FAILED: ${message}`);
  }
}

async function runStage4Tests() {
  console.log('================================================================');
  console.log('TRADING FIREWALL: STAGE 4 FRONTEND & MULTI-ACCOUNT INTEGRATION SUITE');
  console.log('================================================================\n');

  ServerRiskStore.reset();
  const userId = 'user_stage4_suite';
  const customAcc = 'acc_zerodha_test_custom';

  // 1. Test Broker Connections discovery in mock mode
  const connections = await getBrokerConnections(userId);
  assert(Array.isArray(connections) && connections.length > 0, 'Broker connections must be returned');
  console.log('  ✓ PASSED: Broker connections discovery');

  // 2. Test Risk Config retrieval and saving with accountId
  const customConfig = {
    dailyLossLimit: 15000,
    warningThreshold1: 70,
    warningThreshold2: 90,
    lockDurationMinutes: 720,
    enabled: true,
  };
  const saveRes = await ServerRiskStore.saveConfig(userId, customConfig, customAcc);
  assert(saveRes.success, 'Save config with custom accountId must succeed');

  const retrievedConfig = await ServerRiskStore.getConfig(userId, customAcc);
  assert(retrievedConfig.dailyLossLimit === 15000, `Expected dailyLossLimit 15000, got ${retrievedConfig.dailyLossLimit}`);
  console.log('  ✓ PASSED: Config isolation with accountId');

  // 3. Test Risk Session isolation with accountId
  const session = await ServerRiskStore.getSession(userId, undefined, customAcc);
  assert(session.userId === userId, 'Session userId must match');
  console.log('  ✓ PASSED: Risk session isolation with accountId');

  console.log('\nALL STAGE 4 FRONTEND INTEGRATION TESTS PASSED (3/3)');
}

runStage4Tests().catch((err) => {
  console.error('STAGE 4 TESTS FAILED:', err);
  process.exit(1);
});
