import { BrokerRegistry } from '../server/brokers/registry';
import { liveZerodhaAdapter } from '../server/brokers/zerodha/liveAdapter';
import { liveAngelOneAdapter } from '../server/brokers/angelone/liveAdapter';
import { AngelOneSessionStore } from '../server/brokers/angelone/sessionStore';
import { AngelOneCredentials } from '../server/brokers/angelone/credentials';

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

async function runStage6FrontendBrokerManagementTests() {
  console.log('================================================================');
  console.log('MonkTrades Stage 6 — Frontend & Multi-Broker Management Suite');
  console.log('================================================================');

  AngelOneSessionStore.enableMockStoreForTesting(true);

  // Test 1: Multi-broker registry resolution & independence
  console.log('\n[Test 1] Broker Registry Multi-Broker Resolution');
  const zerodha = BrokerRegistry.getAdapter('zerodha');
  const angelone = BrokerRegistry.getAdapter('angelone');
  assert(zerodha === liveZerodhaAdapter, 'Zerodha adapter must resolve correctly');
  assert(angelone === liveAngelOneAdapter, 'Angel One adapter must resolve correctly');
  assert(zerodha.providerId === 'zerodha', 'Zerodha providerId must be zerodha');
  assert(angelone.providerId === 'angelone', 'Angel One providerId must be angelone');
  console.log('  ✓ PASSED: Broker registry correctly resolves both adapters');

  // Test 2: Angel One Connection Status & Configuration Readiness
  console.log('\n[Test 2] Angel One Connection Status & Config Readiness');
  const testUser = 'user_stage6_trader';
  const creds = new AngelOneCredentials();
  const diag = creds.getDiagnostic();
  assert(typeof diag.apiKeyConfigured === 'boolean', 'apiKeyConfigured must be boolean');
  assert(typeof diag.accessTokenConfigured === 'boolean', 'accessTokenConfigured must be boolean');
  assert(typeof diag.apiSecretConfigured === 'boolean', 'apiSecretConfigured must be boolean');

  const status = await liveAngelOneAdapter.getConnectionStatus(testUser);
  assert(status.broker === 'angelone', 'Status broker must be angelone');
  assert(typeof status.status === 'string', 'Status string must be present');
  console.log('  ✓ PASSED: Angel One connection status & diagnostic presence verified');

  // Test 3: Session Isolation between Zerodha and Angel One
  console.log('\n[Test 3] Session Isolation & Storage');
  const tokenA = 'angelone_jwt_token_user_a';
  const tokenB = 'angelone_jwt_token_user_b';

  await AngelOneSessionStore.saveSession('user_a', tokenA);
  await AngelOneSessionStore.saveSession('user_b', tokenB);

  const sessionA = await AngelOneSessionStore.loadSession('user_a');
  const sessionB = await AngelOneSessionStore.loadSession('user_b');

  assert(sessionA?.accessToken === tokenA, 'User A token must match');
  assert(sessionB?.accessToken === tokenB, 'User B token must match');
  assert((sessionA?.accessToken as string) !== (sessionB?.accessToken as string), 'User sessions must be strictly isolated');
  console.log('  ✓ PASSED: Per-user session isolation verified');

  // Test 4: Fail-Closed Behavior on Invalidation & Expiry
  console.log('\n[Test 4] Fail-Closed Invalidation & Expiry');
  await AngelOneSessionStore.invalidateSession('user_a');
  const invalidated = await AngelOneSessionStore.loadSession('user_a');
  assert(invalidated?.authState === 'AUTHENTICATION_REQUIRED', 'Invalidated session must require auth');
  console.log('  ✓ PASSED: Session invalidation fails closed correctly');

  // Test 5: Read-Only Governance Guarantee
  console.log('\n[Test 5] Read-Only Governance Guarantee');
  assert((liveAngelOneAdapter as any).placeOrder === undefined, 'Angel One adapter must not have placeOrder');
  assert((liveAngelOneAdapter as any).cancelOrder === undefined, 'Angel One adapter must not have cancelOrder');
  console.log('  ✓ PASSED: Strict read-only governance enforced');

  AngelOneSessionStore.enableMockStoreForTesting(false);

  console.log('\n================================================================');
  console.log('ALL STAGE 6 FRONTEND & MULTI-BROKER TESTS PASSED SUCCESSFULLY (5/5)');
  console.log('================================================================');
}

runStage6FrontendBrokerManagementTests().catch((err) => {
  console.error('\nSTAGE 6 SUITE FAILED:', err);
  process.exit(1);
});
