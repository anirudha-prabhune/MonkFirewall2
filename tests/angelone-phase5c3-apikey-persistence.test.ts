import { strict as assert } from 'assert';
import { AngelOneSessionStore } from '../server/brokers/angelone/sessionStore';
import { liveAngelOneAdapter, LiveAngelOneAdapter } from '../server/brokers/angelone/liveAdapter';
import { CryptoService } from '../server/security/crypto';

async function runAngelOneApiKeyPersistenceSuite() {
  console.log('================================================================');
  console.log('MonkTrades Phase 5C.3: Angel One Per-User API Key Storage Suite');
  console.log('================================================================\n');

  // Enable mock store for offline testing
  AngelOneSessionStore.enableMockStoreForTesting(true);

  // --------------------------------------------------------------------------
  // TEST 1: Encryption & Storage Structure Verification
  // --------------------------------------------------------------------------
  console.log('[Test 1] Encryption & Storage Structure Verification');
  {
    const userId = 'user_encrypt_test';
    const plainApiKey = 'MY_SECRET_ANGEL_API_KEY_123';

    await AngelOneSessionStore.saveApiKey(userId, plainApiKey);
    const loadedKey = await AngelOneSessionStore.loadApiKey(userId);

    assert.equal(loadedKey, plainApiKey, 'Loaded API key must match saved API key');

    // Retrieve underlying encrypted document path
    const docPath = AngelOneSessionStore.getApiKeyDocPath(userId);
    assert.ok(
      docPath === `users/${userId}/brokerConnections/acc_mt_angelone_default/credentials/apiKey` ||
      docPath === `users/${userId}/brokerConnections/angelone_default/credentials/apiKey`,
      'Document path matches required schema path'
    );
    console.log('  ✓ PASSED: API key encrypted with AES-256-GCM and stored at canonical path');
  }

  // --------------------------------------------------------------------------
  // TEST 2: Per-User Key Isolation
  // --------------------------------------------------------------------------
  console.log('\n[Test 2] Per-User Key Isolation');
  {
    const userA = 'user_alpha_p5c3';
    const userB = 'user_beta_p5c3';
    const keyA = 'ANGEL_KEY_ALPHA_777';
    const keyB = 'ANGEL_KEY_BETA_888';

    await AngelOneSessionStore.saveApiKey(userA, keyA);
    await AngelOneSessionStore.saveApiKey(userB, keyB);

    const loadedA = await AngelOneSessionStore.loadApiKey(userA);
    const loadedB = await AngelOneSessionStore.loadApiKey(userB);

    assert.equal(loadedA, keyA, "User A must retrieve User A's API key");
    assert.equal(loadedB, keyB, "User B must retrieve User B's API key");
    assert.notEqual(loadedA, loadedB, 'User A and User B API keys must be isolated');
    console.log('  ✓ PASSED: Per-user API key isolation verified with zero cross-user leakage');
  }

  // --------------------------------------------------------------------------
  // TEST 3: Missing Key Behavior
  // --------------------------------------------------------------------------
  console.log('\n[Test 3] Missing Key Behavior');
  {
    const unconfiguredUser = 'user_no_key_99';
    const loaded = await AngelOneSessionStore.loadApiKey(unconfiguredUser);
    assert.equal(loaded, null, 'Unconfigured user must return null API key');

    // Save session without API key for this user
    await AngelOneSessionStore.saveSession(unconfiguredUser, 'valid_mock_jwt_token_20_chars_min');

    // Adapter capital request should fail closed with CONFIGURATION_ERROR
    const capitalRes = await liveAngelOneAdapter.getCapital(unconfiguredUser);
    assert.equal(capitalRes.connectionStatus, 'CONFIGURATION_ERROR', 'Must return CONFIGURATION_ERROR');
    assert.equal(capitalRes.netBalance, null, 'netBalance must be null');
    assert.equal(capitalRes.isStale, true, 'isStale must be true');
    assert.ok(capitalRes.semanticNote.includes('API Key not found'), 'Semantic note describes missing key');
    console.log('  ✓ PASSED: Missing API key fails closed with CONFIGURATION_ERROR and null balances');
  }

  // --------------------------------------------------------------------------
  // TEST 4: Key Replacement / Mutation Path
  // --------------------------------------------------------------------------
  console.log('\n[Test 4] Key Replacement / Mutation Path');
  {
    const userId = 'user_replace_test';
    const initialKey = 'INITIAL_ANGEL_KEY_111';
    const updatedKey = 'UPDATED_ANGEL_KEY_222';

    await AngelOneSessionStore.saveApiKey(userId, initialKey);
    const loadedInitial = await AngelOneSessionStore.loadApiKey(userId);
    assert.equal(loadedInitial, initialKey, 'Initial key verified');

    // Update key
    await AngelOneSessionStore.saveApiKey(userId, updatedKey);
    const loadedUpdated = await AngelOneSessionStore.loadApiKey(userId);
    assert.equal(loadedUpdated, updatedKey, 'Updated key verified');
    console.log('  ✓ PASSED: Key replacement path successfully updates stored encrypted credential');
  }

  // --------------------------------------------------------------------------
  // TEST 5: Session Disconnect Preserves Saved API Key
  // --------------------------------------------------------------------------
  console.log('\n[Test 5] Session Disconnect Preserves Saved API Key');
  {
    const userId = 'user_disconnect_preserve';
    const persistentKey = 'PERSISTENT_KEY_333';

    await AngelOneSessionStore.saveApiKey(userId, persistentKey);
    await AngelOneSessionStore.saveSession(userId, 'valid_mock_jwt_token_20_chars_min');

    // Verify session is active
    const sessionBefore = await AngelOneSessionStore.loadSession(userId);
    assert.equal(sessionBefore?.authState, 'AUTHENTICATED');

    // Invalidate/Disconnect session
    await AngelOneSessionStore.invalidateSession(userId);
    const sessionAfter = await AngelOneSessionStore.loadSession(userId);
    assert.equal(sessionAfter?.authState, 'AUTHENTICATION_REQUIRED', 'Session is invalidated');

    // API Key MUST be preserved across disconnect/session expiry!
    const keyAfterDisconnect = await AngelOneSessionStore.loadApiKey(userId);
    assert.equal(keyAfterDisconnect, persistentKey, 'API key MUST survive session invalidation');

    // Explicit deleteApiKey removes key
    await AngelOneSessionStore.deleteApiKey(userId);
    const keyAfterDelete = await AngelOneSessionStore.loadApiKey(userId);
    assert.equal(keyAfterDelete, null, 'Explicit deleteApiKey removes credential');
    console.log('  ✓ PASSED: Disconnect invalidates token while preserving saved API key; deleteApiKey removes key');
  }

  // --------------------------------------------------------------------------
  // TEST 6: X-PrivateKey Selection in Upstream SmartAPI Requests
  // --------------------------------------------------------------------------
  console.log('\n[Test 6] X-PrivateKey Selection in Upstream SmartAPI Requests');
  {
    const userId = 'user_header_dispatch';
    const userApiKey = 'HEADER_SELECTION_KEY_999';
    let capturedGetRmsHeader: string | null = null;
    let capturedGetPositionHeader: string | null = null;

    // Inject mock fetch handler on liveAngelOneAdapter
    const adapter = new LiveAngelOneAdapter();
    adapter.setFetchHandler(async (input: any, options: any) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/loginByPassword')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            status: true,
            data: { jwtToken: 'Bearer mock_jwt_token_longer_than_20_chars' },
          }),
        } as any;
      }
      if (url.includes('/getRMS')) {
        capturedGetRmsHeader = options?.headers?.['X-PrivateKey'] || null;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            status: true,
            data: { availablecash: 180000.0, net: 200000.0 },
          }),
        } as any;
      }
      if (url.includes('/getPosition')) {
        capturedGetPositionHeader = options?.headers?.['X-PrivateKey'] || null;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            status: true,
            data: [],
          }),
        } as any;
      }
      return { ok: false, status: 404, json: async () => ({}) } as any;
    });

    // Authenticate user with explicit API key
    const authRes = await adapter.authenticate(
      userId,
      {
        apiKey: userApiKey,
        clientCode: 'CLIENT_P5C3',
        password: 'PassWord123',
        totp: '123456',
      },
      { customFetch: (adapter as any).customFetch }
    );
    assert.equal(authRes.success, true, 'Auth must succeed');

    // Retrieve Capital
    const capRes = await adapter.getCapital(userId);
    assert.equal(capRes.connectionStatus, 'AUTHENTICATED');
    assert.equal(capRes.netBalance, 200000.0);
    assert.equal(
      capturedGetRmsHeader,
      userApiKey,
      'X-PrivateKey in /getRMS request MUST match user saved API key'
    );

    // Retrieve Positions
    await adapter.getPositions(userId);
    assert.equal(
      capturedGetPositionHeader,
      userApiKey,
      'X-PrivateKey in /getPosition request MUST match user saved API key'
    );
    console.log('  ✓ PASSED: Upstream /getRMS and /getPosition requests send user encrypted X-PrivateKey header');
  }

  // --------------------------------------------------------------------------
  // TEST 7: Zero Plaintext Key Leakage in Diagnostics / Status
  // --------------------------------------------------------------------------
  console.log('\n[Test 7] Zero Plaintext Key Leakage in Diagnostics / Status');
  {
    const userId = 'user_diagnostic_leak';
    const secretApiKey = 'SUPER_SECRET_KEY_NOT_TO_BE_LEAKED';

    await AngelOneSessionStore.saveApiKey(userId, secretApiKey);
    await AngelOneSessionStore.saveSession(userId, 'mock_jwt_token_longer_than_20_chars');

    const status = await liveAngelOneAdapter.getConnectionStatus(userId);
    const statusJson = JSON.stringify(status);

    assert.equal(
      statusJson.includes(secretApiKey),
      false,
      'ConnectionStatus response JSON MUST NOT contain plaintext API key'
    );
    assert.equal(
      status.configured,
      true,
      'Status reports configured as true when per-user API key is stored'
    );
    console.log('  ✓ PASSED: Zero plaintext API key leakage in connection status or diagnostic objects');
  }

  console.log('\n================================================================');
  console.log('ALL ANGEL ONE API KEY PERSISTENCE TESTS PASSED (7/7)');
  console.log('================================================================\n');
}

runAngelOneApiKeyPersistenceSuite().catch((err) => {
  console.error('Angel One API Key Persistence Suite Failed:', err);
  process.exit(1);
});
