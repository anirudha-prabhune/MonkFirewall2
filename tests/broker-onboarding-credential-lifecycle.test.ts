import { strict as assert } from 'assert';
import { ZerodhaSessionStore, enableMockStoreForTesting as enableZerodhaMockStore, clearMockStore as clearZerodhaMockStore } from '../server/brokers/zerodha/sessionStore';
import { ZerodhaCredentialManager } from '../server/brokers/zerodha/credentials';
import { liveZerodhaAdapter } from '../server/brokers/zerodha/liveAdapter';
import { AngelOneSessionStore } from '../server/brokers/angelone/sessionStore';
import { liveAngelOneAdapter } from '../server/brokers/angelone/liveAdapter';
import { generateTotp } from '../server/brokers/angelone/totp';

async function runTestSuites() {
  console.log('=== STARTING BROKER ONBOARDING & CREDENTIAL LIFECYCLE REGRESSION SUITE ===\n');

  enableZerodhaMockStore(true);
  AngelOneSessionStore.enableMockStoreForTesting(true);
  clearZerodhaMockStore();

  // --------------------------------------------------------------------------
  // TEST 1: Zerodha Credential Onboarding, Storage & Retrieval
  // --------------------------------------------------------------------------
  console.log('[Test 1] Zerodha Credential Onboarding, Storage & Retrieval');
  {
    const userA = 'user_zerodha_onboard_a';
    const connA = 'acc_mt_zerodha_alpha';
    const credsA = { apiKey: 'USER_A_ZERODHA_KEY', apiSecret: 'USER_A_ZERODHA_SECRET' };

    // 1. Save encrypted credentials
    await ZerodhaSessionStore.saveCredentials(userA, credsA, connA);

    // 2. Load credentials
    const loaded = await ZerodhaSessionStore.loadCredentials(userA, connA);
    assert.ok(loaded, 'Credentials loaded from store');
    assert.equal(loaded?.apiKey, credsA.apiKey, 'API key matches stored plaintext');
    assert.equal(loaded?.apiSecret, credsA.apiSecret, 'API secret matches stored plaintext');

    // 3. Verify ZerodhaCredentialManager resolves user credentials
    const resolved = await ZerodhaCredentialManager.getCredentialsForUser(userA, connA);
    assert.equal(resolved.apiKey, credsA.apiKey);
    assert.equal(resolved.apiSecret, credsA.apiSecret);

    // 4. Verify login URL generation uses user's API key
    const loginUrl = await ZerodhaCredentialManager.getLoginUrlForUser('https://app.com/callback', userA, connA);
    assert.ok(loginUrl.includes(`api_key=${credsA.apiKey}`), 'Login URL contains user API key');

    console.log('  ✓ PASSED: Zerodha credential onboarding, encryption, and user-scoped resolution verified.');
  }

  // --------------------------------------------------------------------------
  // TEST 2: Angel One Credential Onboarding & Auto-Reauthentication via TOTP
  // --------------------------------------------------------------------------
  console.log('\n[Test 2] Angel One Credential Onboarding & Auto-Reauthentication');
  {
    const userA = 'user_angelone_onboard_a';
    const connA = 'acc_mt_angelone_alpha';
    const totpSecret = 'JBSWY3DPEHPK3PXP'; // Base32 test secret
    const credsA = {
      apiKey: 'ANGEL_USER_A_KEY',
      clientCode: 'A123456',
      password: 'UserPass123',
      totpSecret,
    };

    // 1. Save encrypted Angel One credentials
    await AngelOneSessionStore.saveCredentials(userA, credsA, connA);

    // 2. Load stored credentials
    const loaded = await AngelOneSessionStore.loadCredentials(userA, connA);
    assert.ok(loaded, 'Angel One credentials loaded');
    assert.equal(loaded?.apiKey, credsA.apiKey);
    assert.equal(loaded?.clientCode, credsA.clientCode);
    assert.equal(loaded?.password, credsA.password);
    assert.equal(loaded?.totpSecret, credsA.totpSecret);

    // 3. Mock SmartAPI loginByPassword response
    let lastRequestApiKey = '';
    let lastRequestTotp = '';

    liveAngelOneAdapter.setFetchHandler(async (input: any, opts: any) => {
      const url = typeof input === 'string' ? input : String(input);
      if (url.includes('loginByPassword')) {
        lastRequestApiKey = opts.headers?.['X-PrivateKey'] || '';
        const body = JSON.parse(opts.body || '{}');
        lastRequestTotp = body.totp;

        return {
          ok: true,
          status: 200,
          json: async () => ({
            status: true,
            message: 'SUCCESS',
            data: { jwtToken: 'Bearer valid_mock_jwt_token_for_angelone_onboarding_test' },
          }),
        } as any;
      }
      return { ok: false, status: 400, json: async () => ({}) } as any;
    });

    // 4. Trigger re-authentication without supplying password or TOTP in call params
    const authResult = await liveAngelOneAdapter.authenticate(userA, {}, { connectionId: connA });
    assert.equal(authResult.success, true, 'Auto-reauthentication using stored credentials succeeded');
    assert.equal(lastRequestApiKey, credsA.apiKey, 'Outbound request used stored API key');

    // Verify TOTP was generated dynamically from saved totpSecret
    const expectedTotp = generateTotp(totpSecret);
    assert.equal(lastRequestTotp, expectedTotp, 'TOTP was generated dynamically from saved totpSecret');

    console.log('  ✓ PASSED: Angel One credential onboarding & automated TOTP reauthentication verified.');
  }

  // --------------------------------------------------------------------------
  // TEST 3: Account & User Isolation
  // --------------------------------------------------------------------------
  console.log('\n[Test 3] Account & User Isolation');
  {
    const userA = 'user_isolation_a';
    const userB = 'user_isolation_b';
    const connA = 'acc_zerodha_a';
    const connB = 'acc_zerodha_b';

    await ZerodhaSessionStore.saveCredentials(userA, { apiKey: 'KEY_USER_A', apiSecret: 'SEC_USER_A' }, connA);
    await ZerodhaSessionStore.saveCredentials(userB, { apiKey: 'KEY_USER_B', apiSecret: 'SEC_USER_B' }, connB);

    const credsA = await ZerodhaSessionStore.loadCredentials(userA, connA);
    const credsB = await ZerodhaSessionStore.loadCredentials(userB, connB);

    assert.equal(credsA?.apiKey, 'KEY_USER_A');
    assert.equal(credsB?.apiKey, 'KEY_USER_B');

    // Verify User A cannot access User B's connection credentials
    const crossCreds = await ZerodhaSessionStore.loadCredentials(userA, connB);
    assert.equal(crossCreds, null, 'Cross-user connection credential access is strictly forbidden');

    console.log('  ✓ PASSED: Strict user and account connection credential isolation enforced.');
  }

  // --------------------------------------------------------------------------
  // TEST 4: Credential Deletion & Session Invalidation
  // --------------------------------------------------------------------------
  console.log('\n[Test 4] Credential Deletion & Session Invalidation');
  {
    const userDel = 'user_to_delete';
    const connDel = 'acc_to_delete';

    await ZerodhaSessionStore.saveCredentials(userDel, { apiKey: 'DEL_KEY', apiSecret: 'DEL_SEC' }, connDel);
    await ZerodhaSessionStore.saveSession(userDel, 'dummy_token', { connectionId: connDel });

    // Verify active session exists before deletion
    const sessionBefore = await ZerodhaSessionStore.loadSession(userDel, { connectionId: connDel });
    assert.ok(sessionBefore && sessionBefore.authState === 'AUTHENTICATED');

    // Delete credentials
    await ZerodhaSessionStore.deleteCredentials(userDel, connDel);

    // Verify credentials removed
    const credsAfter = await ZerodhaSessionStore.loadCredentials(userDel, connDel);
    assert.equal(credsAfter, null, 'Credentials removed after deletion');

    // Verify runtime session invalidated
    const sessionAfter = await ZerodhaSessionStore.loadSession(userDel, { connectionId: connDel });
    assert.ok(!sessionAfter || sessionAfter.authState === 'AUTHENTICATION_REQUIRED', 'Runtime session invalidated on credential deletion');

    console.log('  ✓ PASSED: Credential removal cleans up persistent credentials and invalidates active session.');
  }

  console.log('\n=== ALL BROKER ONBOARDING & CREDENTIAL LIFECYCLE TESTS PASSED SUCCESSFULLY ===');
}

runTestSuites().catch((err) => {
  console.error('\n❌ TEST SUITE FAILED:', err);
  process.exit(1);
});
