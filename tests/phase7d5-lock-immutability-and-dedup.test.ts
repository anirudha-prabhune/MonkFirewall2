import { strict as assert } from 'assert';
import { getFriendlyAccountLabel } from '../src/utils/formatters';
import { ServerRiskStore, DEFAULT_ACCOUNT_ID, DEFAULT_ANGELONE_ACCOUNT_ID } from '../server/risk/store';
import { getBrokerConnections } from '../src/services/brokerConnectionService';
import { enableMockStoreForTesting, setAdminFirestoreForTesting } from '../server/brokers/zerodha/sessionStore';
import { DEFAULT_RISK_CONFIG } from '../src/types/risk';

async function runPhase7D5Tests() {
  console.log('================================================================');
  console.log('MONKTRADES PHASE 7D.5: DEDUP & LOCK IMMUTABILITY SUITE');
  console.log('Broker Identity Labels, Deduplication & Locked-Limit Immutability');
  console.log('================================================================');

  enableMockStoreForTesting(true);
  setAdminFirestoreForTesting(null);
  ServerRiskStore.reset();

  const userId = 'user_p7d5_test';

  // TEST 1: Broker Identity Labels (No invented Primary/Secondary labels)
  try {
    const labelZerodha = getFriendlyAccountLabel(DEFAULT_ACCOUNT_ID, 'zerodha');
    const labelSecondary = getFriendlyAccountLabel('acc_zerodha_secondary', 'zerodha');
    const labelAngel = getFriendlyAccountLabel(DEFAULT_ANGELONE_ACCOUNT_ID, 'angelone');

    assert.equal(labelZerodha, 'Zerodha', 'Zerodha label shows clean Zerodha name');
    assert.equal(labelSecondary, 'Zerodha (acc_zerodha_secondary)', 'Zerodha secondary shows broker and ID');
    assert.equal(labelAngel, 'Angel One', 'Angel One label shows clean Angel One name');

    console.log('  ✓ PASSED: Broker identity labels display broker name and genuine account identity without invented suffixes');
  } catch (err) {
    console.error('  ✗ FAILED TEST 1:', err);
    process.exit(1);
  }

  // TEST 2: Account Discovery & Deduplication (No duplicate Zerodha entries for aliases)
  try {
    const connections = await getBrokerConnections(userId);
    const idSet = new Set(connections.map(c => c.connectionId));
    assert.equal(idSet.size, connections.length, 'All returned connectionIds must be unique with no duplicate entries');
    assert(idSet.has(DEFAULT_ACCOUNT_ID), 'Must include default Zerodha account');
    assert(idSet.has(DEFAULT_ANGELONE_ACCOUNT_ID), 'Must include Angel One account');

    console.log('  ✓ PASSED: Account discovery removes duplicate aliases and preserves distinct accounts');
  } catch (err) {
    console.error('  ✗ FAILED TEST 2:', err);
    process.exit(1);
  }

  // TEST 3: Locked-Limit Immutability via API / ServerRiskStore
  try {
    // 1. Save initial config for default account
    await ServerRiskStore.saveConfig(userId, {
      ...DEFAULT_RISK_CONFIG,
      dailyLossLimit: 10000,
      accountId: DEFAULT_ACCOUNT_ID,
      broker: 'zerodha',
    }, DEFAULT_ACCOUNT_ID);

    // 2. Force session to LOCKED state for default account
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    const userState = (ServerRiskStore as any).getOrCreateUserState(userId);
    const sessionKey = `${DEFAULT_ACCOUNT_ID}__${today}`;
    userState.accountSessions.set(sessionKey, {
      tradingDate: today,
      userId,
      state: 'LOCKED',
      isBreached: true,
      lockedAt: new Date().toISOString(),
      lockUntil: new Date(Date.now() + 3600000).toISOString(),
      currentPnl: -15000,
      realisedPnl: -15000,
      unrealisedPnl: 0,
      lossLimit: 10000,
      warningThreshold1: 70,
      warningThreshold2: 90,
      lastEvaluatedAt: new Date().toISOString(),
      reason: 'Daily loss limit reached',
    });

    // 3. Attempt to mutate dailyLossLimit while LOCKED -> must be rejected with RISK_CONFIG_LOCKED
    const mutationRes = await ServerRiskStore.saveConfig(userId, {
      ...DEFAULT_RISK_CONFIG,
      dailyLossLimit: 20000,
      accountId: DEFAULT_ACCOUNT_ID,
      broker: 'zerodha',
    }, DEFAULT_ACCOUNT_ID);

    assert.equal(mutationRes.success, false, 'Mutation must be rejected while LOCKED');
    assert.equal(mutationRes.code, 'RISK_CONFIG_LOCKED', 'Error code must be RISK_CONFIG_LOCKED');

    console.log('  ✓ PASSED: Server-side save validation prevents Daily Loss Limit modifications while LOCKED');
  } catch (err) {
    console.error('  ✗ FAILED TEST 3:', err);
    process.exit(1);
  }

  // TEST 4: Allowed edits after authorized reset
  try {
    // 1. Perform authorized reset
    await ServerRiskStore.resetSession(userId, DEFAULT_ACCOUNT_ID);

    // 2. Attempt config mutation after reset -> must succeed
    const postResetMutation = await ServerRiskStore.saveConfig(userId, {
      ...DEFAULT_RISK_CONFIG,
      dailyLossLimit: 15000,
      accountId: DEFAULT_ACCOUNT_ID,
      broker: 'zerodha',
    }, DEFAULT_ACCOUNT_ID);

    assert.equal(postResetMutation.success, true, 'Mutation must succeed after authorized session reset');
    assert.equal(postResetMutation.config?.dailyLossLimit, 15000, 'New daily loss limit is saved successfully');

    console.log('  ✓ PASSED: Configuration changes are allowed after authorized session reset');
  } catch (err) {
    console.error('  ✗ FAILED TEST 4:', err);
    process.exit(1);
  }

  // TEST 5: Independent account configurations remain unaffected
  try {
    // Lock account 1, verify account 2 config can still be updated independently
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    const userState = (ServerRiskStore as any).getOrCreateUserState(userId);
    userState.accountSessions.set(`${DEFAULT_ACCOUNT_ID}__${today}`, {
      tradingDate: today,
      userId,
      state: 'LOCKED',
      isBreached: true,
      lockedAt: new Date().toISOString(),
      lockUntil: new Date(Date.now() + 3600000).toISOString(),
      currentPnl: -12000,
      lossLimit: 10000,
    });

    // Account 2 update should succeed because Account 2 session is not locked
    const acc2Mutation = await ServerRiskStore.saveConfig(userId, {
      ...DEFAULT_RISK_CONFIG,
      dailyLossLimit: 25000,
      accountId: 'acc_zerodha_secondary',
      broker: 'zerodha',
    }, 'acc_zerodha_secondary');

    assert.equal(acc2Mutation.success, true, 'Account 2 configuration update succeeds independently while Account 1 is locked');
    assert.equal(acc2Mutation.config?.dailyLossLimit, 25000);

    console.log('  ✓ PASSED: Account configurations remain fully independent during locks');
  } catch (err) {
    console.error('  ✗ FAILED TEST 5:', err);
    process.exit(1);
  }

  console.log('================================================================');
  console.log('ALL PHASE 7D.5 TESTS PASSED SUCCESSFULLY!');
  console.log('================================================================');
  process.exit(0);
}

runPhase7D5Tests().catch((err) => {
  console.error('Phase 7D.5 test suite failed:', err);
  process.exit(1);
});
