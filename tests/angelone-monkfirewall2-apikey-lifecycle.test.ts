import { strict as assert } from 'assert';
import { AngelOneSessionStore } from '../server/brokers/angelone/sessionStore';
import { liveAngelOneAdapter, LiveAngelOneAdapter } from '../server/brokers/angelone/liveAdapter';

async function runMonkFirewall2ApiKeyLifecycleSuite() {
  console.log('================================================================');
  console.log('MonkFirewall2: Angel One API Key Lifecycle & Resilience Suite');
  console.log('================================================================\n');

  AngelOneSessionStore.enableMockStoreForTesting(true);

  // --------------------------------------------------------------------------
  // TEST 1: Per-User, Per-Connection API Key Persistence & Decryption
  // --------------------------------------------------------------------------
  console.log('[Test 1] Per-User, Per-Connection Key Persistence & Decryption');
  {
    const userId = 'mf2_user_key_persist';
    const apiKey = 'ANGEL_SMARTAPI_KEY_9999_SECURE';

    await AngelOneSessionStore.saveApiKey(userId, apiKey);
    const loadedKey = await AngelOneSessionStore.loadApiKey(userId);

    assert.equal(loadedKey, apiKey, 'Loaded API key must match saved API key');
    console.log('  ✓ PASSED: API key saved, encrypted, and decrypted per user');
  }

  // --------------------------------------------------------------------------
  // TEST 2: Correct Request Headers Dispatch (X-PrivateKey)
  // --------------------------------------------------------------------------
  console.log('\n[Test 2] Header Dispatch (X-PrivateKey)');
  {
    const userId = 'mf2_user_header_dispatch';
    const userApiKey = 'HEADER_DISPATCH_KEY_12345';
    let capturedGetRmsHeader: string | null = null;
    let capturedGetPositionHeader: string | null = null;

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
            data: { availablecash: 250000.0, net: 250000.0 },
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

    const authRes = await adapter.authenticate(
      userId,
      {
        apiKey: userApiKey,
        clientCode: 'CLIENT_MF2',
        password: 'PassWord123',
        totp: '123456',
      },
      { customFetch: (adapter as any).customFetch }
    );
    assert.equal(authRes.success, true, 'Auth must succeed');

    await adapter.getCapital(userId);
    assert.equal(capturedGetRmsHeader, userApiKey, 'X-PrivateKey in /getRMS must match saved API key');

    await adapter.getPositions(userId);
    assert.equal(capturedGetPositionHeader, userApiKey, 'X-PrivateKey in /getPosition must match saved API key');

    console.log('  ✓ PASSED: X-PrivateKey header correctly set for both /getRMS and /getPosition');
  }

  // --------------------------------------------------------------------------
  // TEST 3: Partial Authentication Persistence Prevention (Failure Rollback)
  // --------------------------------------------------------------------------
  console.log('\n[Test 3] Partial Authentication Persistence Prevention');
  {
    const userId = 'mf2_user_partial_auth';

    // Pre-seed an existing valid session doc for user
    await AngelOneSessionStore.saveSession(userId, 'existing_valid_mock_jwt_token_20_chars', {
      clientCode: 'OLD_CLIENT',
    });
    const sessionBefore = await AngelOneSessionStore.loadSession(userId);
    assert.equal(sessionBefore?.authState, 'AUTHENTICATED');

    // Create an adapter that fails on saveApiKey
    const originalSaveApiKey = AngelOneSessionStore.saveApiKey;
    AngelOneSessionStore.saveApiKey = async () => {
      throw new Error('Simulated Firestore API key write failure');
    };

    const adapter = new LiveAngelOneAdapter();
    adapter.setFetchHandler(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        status: true,
        data: { jwtToken: 'Bearer mock_jwt_token_longer_than_20_chars' },
      }),
    }) as any);

    const authRes = await adapter.authenticate(userId, {
      apiKey: 'FAIL_KEY_123',
      clientCode: 'CLIENT_FAIL',
      password: 'PassWord123',
      totp: '123456',
    });

    assert.equal(authRes.success, false, 'Auth must fail when API key persistence fails');

    // Restore original saveApiKey
    AngelOneSessionStore.saveApiKey = originalSaveApiKey;

    // Verify session store has NO active session remaining
    const sessionAfter = await AngelOneSessionStore.loadSession(userId);
    assert.equal(
      sessionAfter?.authState,
      'AUTHENTICATION_REQUIRED',
      'Session must be invalidated on API key persistence failure'
    );

    console.log('  ✓ PASSED: Zero partial authentication persistence when API key write fails');
  }

  // --------------------------------------------------------------------------
  // TEST 4: Distinguish Local Session Validity vs Missing API Key
  // --------------------------------------------------------------------------
  console.log('\n[Test 4] Local Session Validity vs Missing API Key');
  {
    const userId = 'mf2_user_missing_key_status';

    // Save active session but delete stored API key
    await AngelOneSessionStore.saveSession(userId, 'mock_jwt_token_longer_than_20_chars');
    await AngelOneSessionStore.deleteApiKey(userId);

    const status = await liveAngelOneAdapter.getConnectionStatus(userId);
    assert.equal(status.status, 'CONFIGURATION_ERROR', 'Must report CONFIGURATION_ERROR when API key is missing');
    assert.equal(status.authenticated, false, 'authenticated must be false when API key is missing');
    assert.ok(status.message.includes('API Key not found'), 'Message describes missing API key');

    console.log('  ✓ PASSED: Missing API key fails closed with CONFIGURATION_ERROR despite session doc');
  }

  // --------------------------------------------------------------------------
  // TEST 5: Invalid-Key & Unauthorized Upstream SmartAPI Responses
  // --------------------------------------------------------------------------
  console.log('\n[Test 5] Invalid-Key & Upstream Error Responses');
  {
    const userId = 'mf2_user_invalid_key_resp';
    await AngelOneSessionStore.saveApiKey(userId, 'INVALID_KEY_123');
    await AngelOneSessionStore.saveSession(userId, 'mock_jwt_token_longer_than_20_chars');

    const adapter = new LiveAngelOneAdapter();
    adapter.setFetchHandler(async (input: any) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/getPosition')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            status: false,
            message: 'Invalid Private Key or API Key Provided',
            errorcode: 'AG8003',
          }),
        } as any;
      }
      return { ok: false, status: 400, json: async () => ({}) } as any;
    });

    try {
      await adapter.getPositions(userId);
      assert.fail('Should have thrown on invalid key error code AG8003');
    } catch (err: any) {
      assert.ok(err.message.includes('AG8003'), 'Surfaces error code AG8003');
      assert.ok(err.message.includes('Invalid Private Key'), 'Surfaces sanitized error message');
      assert.ok(err.message.includes('Re-authentication required'), 'Indicates re-authentication required');
    }

    // Verify connection status is now AUTHENTICATION_REQUIRED
    const status = await adapter.getConnectionStatus(userId);
    assert.equal(status.status, 'AUTHENTICATION_REQUIRED', 'Session invalidated locally after invalid key error');

    console.log('  ✓ PASSED: Invalid key response surfaces error code/message and invalidates session');
  }

  console.log('\n================================================================');
  console.log('ALL MONKFIREWALL2 API KEY LIFECYCLE TESTS PASSED (5/5)');
  console.log('================================================================\n');
}

runMonkFirewall2ApiKeyLifecycleSuite().catch((err) => {
  console.error('MonkFirewall2 API Key Lifecycle Suite Failed:', err);
  process.exit(1);
});
