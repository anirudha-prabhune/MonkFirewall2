import { strict as assert } from 'assert';
import { AngelOneSessionStore, normalizeAngelOneConnectionId } from '../server/brokers/angelone/sessionStore';
import { liveAngelOneAdapter } from '../server/brokers/angelone/liveAdapter';
import { DEFAULT_ANGELONE_ACCOUNT_ID } from '../src/types/risk';

async function runPositionsDisconnectRegressionSuite() {
  console.log('================================================================');
  console.log('MonkFirewall2: Angel One Positions Disconnect Regression Suite');
  console.log('================================================================\n');

  AngelOneSessionStore.enableMockStoreForTesting(true);

  const userId = 'user_positions_test_101';
  const accountId = 'acc_mt_angelone_default';

  // --------------------------------------------------------------------------
  // TEST 1: AccountId and ConnectionId Normalization Alignment
  // --------------------------------------------------------------------------
  console.log('[Test 1] Connection ID Normalization & Doc Path Alignment');
  {
    const norm1 = normalizeAngelOneConnectionId(accountId);
    const norm2 = normalizeAngelOneConnectionId('angelone_default');
    const norm3 = normalizeAngelOneConnectionId(undefined);

    assert.equal(norm1, DEFAULT_ANGELONE_ACCOUNT_ID, 'acc_mt_angelone_default must map to canonical account ID');
    assert.equal(norm2, DEFAULT_ANGELONE_ACCOUNT_ID, 'angelone_default must map to canonical account ID');
    assert.equal(norm3, DEFAULT_ANGELONE_ACCOUNT_ID, 'undefined must map to canonical account ID');

    const path1 = AngelOneSessionStore.getSessionDocPath(userId, accountId);
    const path2 = AngelOneSessionStore.getSessionDocPath(userId, 'angelone_default');
    assert.equal(path1, path2, 'Both accountId representations MUST point to the same Firestore session doc path');

    console.log('  ✓ PASSED: Canonical Firestore doc path verified for acc_mt_angelone_default');
  }

  // --------------------------------------------------------------------------
  // TEST 2: Scoped Invalidation & Non-Interference Across Connections
  // --------------------------------------------------------------------------
  console.log('\n[Test 2] Connection-Scoped Session Invalidation Integrity');
  {
    const connA = 'acc_mt_angelone_default';
    const connB = 'acc_mt_angelone_secondary';

    // Save API key for both connections
    await AngelOneSessionStore.saveApiKey(userId, 'API_KEY_CONN_A', connA);
    await AngelOneSessionStore.saveApiKey(userId, 'API_KEY_CONN_B', connB);

    // Invalidate connection B
    await AngelOneSessionStore.invalidateSession(userId, undefined, connB);

    // Save active session for connection A
    await AngelOneSessionStore.saveSession(userId, 'Bearer mock_jwt_token_for_conn_A_long_token', { connectionId: connA });

    // Connection A must remain AUTHENTICATED
    const statusA = await liveAngelOneAdapter.getConnectionStatus(userId, { connectionId: connA });
    assert.equal(statusA.status, 'AUTHENTICATED', 'Connection A must remain AUTHENTICATED despite invalidation on Connection B');
    assert.equal(statusA.authenticated, true);

    // Connection B must report AUTHENTICATION_REQUIRED
    const statusB = await liveAngelOneAdapter.getConnectionStatus(userId, { connectionId: connB });
    assert.equal(statusB.status, 'AUTHENTICATION_REQUIRED', 'Connection B must report AUTHENTICATION_REQUIRED');

    console.log('  ✓ PASSED: Session invalidations are strictly isolated per connectionId');
  }

  // --------------------------------------------------------------------------
  // TEST 3: Fail-Closed Status when Session Unauthenticated
  // --------------------------------------------------------------------------
  console.log('\n[Test 3] Fail-Closed Status for Unauthenticated / Missing Sessions');
  {
    const unauthUserId = 'unauth_trader_999';
    await AngelOneSessionStore.saveApiKey(unauthUserId, 'MOCK_API_KEY_999', accountId);
    const status = await liveAngelOneAdapter.getConnectionStatus(unauthUserId, { connectionId: accountId });
    assert.equal(status.status, 'AUTHENTICATION_REQUIRED', 'Missing session must fail closed with AUTHENTICATION_REQUIRED');
    assert.equal(status.authenticated, false);

    console.log('  ✓ PASSED: Unauthenticated positions lookup fails closed safely');
  }

  // --------------------------------------------------------------------------
  // TEST 4: Successful Positions Fetch for Authenticated Account
  // --------------------------------------------------------------------------
  console.log('\n[Test 4] Positions Fetch End-to-End for Authenticated Session');
  {
    liveAngelOneAdapter.setFetchHandler(async (input: any) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/getPosition')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            status: true,
            data: [
              {
                exchange: 'NFO',
                tradingsymbol: 'BANKNIFTY26OCT50000CE',
                producttype: 'CARRYFORWARD',
                netqty: '25',
                avgprice: '150.0',
                ltp: '180.0',
                pnl: '750.0',
                symboltoken: '35001',
              },
            ],
          }),
        } as any;
      }
      return { ok: false, status: 400, json: async () => ({}) } as any;
    });

    const positions = await liveAngelOneAdapter.getPositions(userId, { connectionId: accountId });
    assert.equal(positions.length, 1, 'Should return 1 position');
    assert.equal(positions[0].tradingsymbol, 'BANKNIFTY26OCT50000CE');
    assert.equal(positions[0].pnl, 750);

    console.log('  ✓ PASSED: Valid Angel One positions fetched and returned successfully');
  }

  console.log('\n================================================================');
  console.log('ALL POSITIONS DISCONNECT REGRESSION TESTS PASSED (4/4)');
  console.log('================================================================\n');
}

runPositionsDisconnectRegressionSuite().catch((err) => {
  console.error('Test Suite Failed:', err);
  process.exit(1);
});
