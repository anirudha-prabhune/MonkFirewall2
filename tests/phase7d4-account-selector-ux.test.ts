import { strict as assert } from 'assert';
import { getFriendlyAccountLabel } from '../src/utils/formatters';
import { DEFAULT_ACCOUNT_ID, DEFAULT_ANGELONE_ACCOUNT_ID } from '../server/risk/store';
import { getBrokerConnections } from '../src/services/brokerConnectionService';
import { enableMockStoreForTesting, setAdminFirestoreForTesting } from '../server/brokers/zerodha/sessionStore';

async function runPhase7D4Tests() {
  console.log('================================================================');
  console.log('MONKTRADES PHASE 7D.4: ACCOUNT SELECTOR UX & CLEANUP SUITE');
  console.log('Friendly Account Labels, Alias Deduplication & Account Mapping');
  console.log('================================================================');

  // TEST 1: Friendly Account Label Formatting
  try {
    const labelPrimary = getFriendlyAccountLabel(DEFAULT_ACCOUNT_ID, 'zerodha');
    const labelSecondary = getFriendlyAccountLabel('acc_zerodha_secondary', 'zerodha');
    const labelAngel = getFriendlyAccountLabel(DEFAULT_ANGELONE_ACCOUNT_ID, 'angelone');

    assert.equal(labelPrimary, 'Zerodha', 'Default Zerodha shows clean Zerodha name');
    assert.equal(labelSecondary, 'Zerodha (acc_zerodha_secondary)', 'Zerodha secondary shows broker and ID');
    assert.equal(labelAngel, 'Angel One', 'Default Angel One shows clean Angel One name');

    console.log('  ✓ PASSED: Friendly account label formatting');
  } catch (err) {
    console.error('  ✗ FAILED TEST 1:', err);
    process.exit(1);
  }

  // TEST 2: Account Discovery & Alias Deduplication
  try {
    enableMockStoreForTesting(true);
    setAdminFirestoreForTesting(null);

    const userId = 'user_p7d4_test';
    const connections = await getBrokerConnections(userId);

    // Verify no duplicate account IDs
    const idSet = new Set(connections.map(c => c.connectionId));
    assert.equal(idSet.size, connections.length, 'All returned connectionIds must be unique (no duplicate entries)');

    // Verify expected accounts are present
    assert(idSet.has(DEFAULT_ACCOUNT_ID), 'Must include default Zerodha account ID');
    assert(idSet.has(DEFAULT_ANGELONE_ACCOUNT_ID), 'Must include Angel One account ID');

    console.log('  ✓ PASSED: Account discovery, alias resolution and deduplication');
  } catch (err) {
    console.error('  ✗ FAILED TEST 2:', err);
    process.exit(1);
  }

  console.log('================================================================');
  console.log('ALL PHASE 7D.4 TESTS PASSED SUCCESSFULLY!');
  console.log('================================================================');
}

runPhase7D4Tests().then(() => {
  process.exit(0);
}).catch((err) => {
  console.error('Phase 7D.4 test suite failed:', err);
  process.exit(1);
});
