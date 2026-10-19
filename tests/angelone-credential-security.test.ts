import { strict as assert } from 'assert';
import { CryptoService } from '../server/security/crypto';
import {
  AngelOneSessionStore,
  inMemoryTestStore,
  inMemoryTestApiKeyStore,
  inMemoryTestCredentialsStore,
  PersistedAngelOneSessionDoc,
  PersistedAngelOneApiKeyDoc,
  PersistedAngelOneCredentialsDoc,
} from '../server/brokers/angelone/sessionStore';

async function runAngelOneCredentialSecurityTestSuite() {
  console.log('================================================================');
  console.log('Angel One Credential & Session Security Test Suite');
  console.log('================================================================\n');

  AngelOneSessionStore.enableMockStoreForTesting(true);

  // --------------------------------------------------------------------------
  // TEST 1: New Angel One Credentials Round-Trip Correctly
  // --------------------------------------------------------------------------
  console.log('[Test 1] New Angel One Credentials, API Key, and Session Round-Trip');
  {
    const userId = 'trader_new_1';
    const connId = 'acc_mt_angelone_sec1';

    // 1a. Full credentials
    const creds = {
      apiKey: 'APIKEY_SEC_1',
      clientCode: 'CLIENT_SEC_1',
      password: 'PASSWORD_SEC_1',
      totpSecret: 'TOTP_SEC_1',
    };
    await AngelOneSessionStore.saveCredentials(userId, creds, connId);

    const loadedCreds = await AngelOneSessionStore.loadCredentials(userId, connId);
    assert.deepEqual(loadedCreds, creds, 'New Angel One credentials must round-trip correctly');

    // 1b. Standalone API key
    await AngelOneSessionStore.saveApiKey(userId, 'APIKEY_STANDALONE_1', connId);
    const loadedKey = await AngelOneSessionStore.loadApiKey(userId, connId);
    assert.equal(loadedKey, 'APIKEY_STANDALONE_1', 'New Angel One API key must round-trip correctly');

    // 1c. Session token
    const tokenVal = 'Bearer mock_session_jwt_token_for_testing_12345';
    await AngelOneSessionStore.saveSession(userId, tokenVal, { connectionId: connId });
    const loadedSession = await AngelOneSessionStore.loadSession(userId, { connectionId: connId });
    assert.ok(loadedSession, 'Session must exist');
    assert.equal(loadedSession?.accessToken, tokenVal, 'New session token must round-trip correctly');
    assert.equal(loadedSession?.authState, 'AUTHENTICATED');

    console.log('  ✓ PASSED: New credentials, API key, and session round-trip correctly with provider angelone and connection ID.');
  }

  // --------------------------------------------------------------------------
  // TEST 2: Connection Isolation / Cross-Decryption Prevention
  // --------------------------------------------------------------------------
  console.log('\n[Test 2] Connection Isolation (Connection IDs Cannot Cross-Decrypt)');
  {
    const userId = 'trader_iso_2';
    const connA = 'acc_mt_angelone_connA';
    const connB = 'acc_mt_angelone_connB';

    const credsA = {
      apiKey: 'APIKEY_CONNA',
      clientCode: 'CLIENT_CONNA',
      password: 'PASS_CONNA',
      totpSecret: 'TOTP_CONNA',
    };
    await AngelOneSessionStore.saveCredentials(userId, credsA, connA);
    await AngelOneSessionStore.saveSession(userId, 'Bearer token_connA_123456789', { connectionId: connA });

    // Connection B must NOT decrypt Connection A credentials
    const loadedCredsB = await AngelOneSessionStore.loadCredentials(userId, connB);
    assert.equal(loadedCredsB, null, 'Connection B must not cross-decrypt Connection A credentials');

    // Connection B must NOT decrypt Connection A session
    const loadedSessionB = await AngelOneSessionStore.loadSession(userId, { connectionId: connB });
    assert.equal(loadedSessionB, null, 'Connection B must not cross-decrypt Connection A session');

    console.log('  ✓ PASSED: Connection IDs are strictly isolated and cross-decryption between connection IDs is rejected.');
  }

  // --------------------------------------------------------------------------
  // TEST 3: Legacy Credentials & Sessions Backward-Compatible Readability
  // --------------------------------------------------------------------------
  console.log('\n[Test 3] Legacy Credentials & Sessions Compatibility');
  {
    const userId = 'trader_legacy_3';
    const connId = 'acc_mt_angelone_default';

    // 3a. Legacy API key encrypted with default provider 'zerodha' and no connectionId AAD
    const legacyApiKeyEncrypted = CryptoService.encrypt('LEGACY_API_KEY_ZERODHA_PROVIDER', userId);
    const legacyApiKeyDocPath = AngelOneSessionStore.getApiKeyDocPath(userId, connId);
    const legacyApiKeyDoc: PersistedAngelOneApiKeyDoc = {
      provider: 'angelone',
      userId,
      encryptedApiKey: legacyApiKeyEncrypted,
      updatedAt: new Date().toISOString(),
    };
    inMemoryTestApiKeyStore.set(legacyApiKeyDocPath, legacyApiKeyDoc);

    const readLegacyKey = await AngelOneSessionStore.loadApiKey(userId, connId);
    assert.equal(readLegacyKey, 'LEGACY_API_KEY_ZERODHA_PROVIDER', 'Legacy API key must be decrypted via backward-compatible migration fallback');

    // 3b. Legacy full credentials encrypted with default provider 'zerodha' and no connectionId AAD
    const legacyCredsDocPath = AngelOneSessionStore.getCredentialsDocPath(userId, connId);
    const legacyCredsDoc: PersistedAngelOneCredentialsDoc = {
      provider: 'angelone',
      userId,
      connectionId: connId,
      encryptedApiKey: CryptoService.encrypt('LEGACY_FULL_APIKEY', userId),
      encryptedClientCode: CryptoService.encrypt('LEGACY_FULL_CLIENTCODE', userId),
      encryptedPassword: CryptoService.encrypt('LEGACY_FULL_PASSWORD', userId),
      encryptedTotpSecret: CryptoService.encrypt('LEGACY_FULL_TOTP', userId),
      updatedAt: new Date().toISOString(),
    };
    inMemoryTestCredentialsStore.set(legacyCredsDocPath, legacyCredsDoc);

    const readLegacyCreds = await AngelOneSessionStore.loadCredentials(userId, connId);
    assert.ok(readLegacyCreds, 'Legacy full credentials must be decrypted successfully');
    assert.equal(readLegacyCreds?.apiKey, 'LEGACY_FULL_APIKEY');
    assert.equal(readLegacyCreds?.clientCode, 'LEGACY_FULL_CLIENTCODE');
    assert.equal(readLegacyCreds?.password, 'LEGACY_FULL_PASSWORD');
    assert.equal(readLegacyCreds?.totpSecret, 'LEGACY_FULL_TOTP');

    // 3c. Legacy session encrypted with provider 'angelone' and no connectionId AAD
    const legacySessionDocPath = AngelOneSessionStore.getSessionDocPath(userId, connId);
    const now = new Date();
    const expiryUtc = new Date(now.getTime() + 24 * 3600 * 1000);
    const legacySessionDoc: PersistedAngelOneSessionDoc = {
      provider: 'angelone',
      userId,
      clientCode: 'LEGACY_CLIENT',
      encryptedToken: CryptoService.encrypt('Bearer legacy_session_token_angelone_provider', userId, 'angelone'),
      authState: 'AUTHENTICATED',
      issuedAt: now.toISOString(),
      expiresAt: expiryUtc.toISOString(),
      updatedAt: now.toISOString(),
      sessionVersion: 1,
    };
    inMemoryTestStore.set(legacySessionDocPath, legacySessionDoc);

    const readLegacySession = await AngelOneSessionStore.loadSession(userId, { connectionId: connId });
    assert.ok(readLegacySession, 'Legacy session must be decrypted successfully');
    assert.equal(readLegacySession?.accessToken, 'Bearer legacy_session_token_angelone_provider');
    assert.equal(readLegacySession?.authState, 'AUTHENTICATED');

    console.log('  ✓ PASSED: Legacy credentials and sessions encrypted with prior formats remain readable.');
  }

  console.log('\n================================================================');
  console.log('ALL ANGEL ONE CREDENTIAL SECURITY TESTS PASSED (3/3)');
  console.log('================================================================\n');
}

runAngelOneCredentialSecurityTestSuite().catch((err) => {
  console.error('Test Suite Failed:', err);
  process.exit(1);
});
