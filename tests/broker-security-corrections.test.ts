import { strict as assert } from 'assert';
import { CryptoService, DecryptionError } from '../server/security/crypto';
import { ZerodhaSessionStore, enableMockStoreForTesting as enableZerodhaMockStore, clearMockStore as clearZerodhaMockStore } from '../server/brokers/zerodha/sessionStore';
import { ZerodhaCredentialManager } from '../server/brokers/zerodha/credentials';

async function runSecurityCorrectionsSuite() {
  console.log('=== STARTING BROKER CREDENTIAL SECURITY CORRECTIONS TEST SUITE ===\n');

  enableZerodhaMockStore(true);
  clearZerodhaMockStore();

  const originalEnv = { ...process.env };

  try {
    // --------------------------------------------------------------------------
    // TEST 1: Production Encryption Key Requirement & Fail-Closed Behavior
    // --------------------------------------------------------------------------
    console.log('[Test 1] Key Absence & Fail-Closed in Production');
    {
      process.env.NODE_ENV = 'production';
      delete process.env.SESSION_ENCRYPTION_KEY_1;
      delete process.env.SESSION_ENCRYPTION_KEY;
      delete process.env.BROKER_ENCRYPTION_KEY;
      delete process.env.ZERODHA_ENCRYPTION_KEY;
      delete process.env.TEST_MODE;

      const key = CryptoService.getKeyForVersion(1);
      assert.equal(key, null, 'In production without encryption key env var, key resolution MUST return null');

      assert.throws(
        () => CryptoService.encrypt('secret_token', 'user_prod', 'zerodha', 'conn_1'),
        (err: Error) => err.message.includes('Encryption key for version 1 is unavailable'),
        'Encrypting without production key must throw error'
      );

      console.log('  ✓ PASSED: Production fail-closed behavior verified when key is absent.');
    }

    // Restore test env
    process.env.NODE_ENV = 'test';

    // --------------------------------------------------------------------------
    // TEST 2: Disable Environment-Credential Fallback for Customers in Production
    // --------------------------------------------------------------------------
    console.log('\n[Test 2] Customer Credentials Fallback Disabled in Production');
    {
      process.env.ZERODHA_API_KEY = 'ENV_FALLBACK_KEY';
      process.env.ZERODHA_API_SECRET = 'ENV_FALLBACK_SECRET';
      process.env.NODE_ENV = 'production';
      delete process.env.TEST_MODE;

      const customerCreds = await ZerodhaCredentialManager.getCredentialsForUser('customer_user_999', 'conn_customer');
      assert.equal(customerCreds.apiKey, undefined, 'Customer API key must not fallback to environment in production');
      assert.equal(customerCreds.apiSecret, undefined, 'Customer API secret must not fallback to environment in production');

      console.log('  ✓ PASSED: Environment fallback disabled for customer connections in production.');
    }

    // Restore test env
    process.env.NODE_ENV = 'test';

    // --------------------------------------------------------------------------
    // TEST 3: Zerodha Session Caching Scoped by both userId AND connectionId
    // --------------------------------------------------------------------------
    console.log('\n[Test 3] Zerodha Session Caching Isolation (userId + connectionId)');
    {
      const userId = 'user_multi_conn';
      const conn1 = 'conn_alpha';
      const conn2 = 'conn_beta';

      ZerodhaCredentialManager.setRuntimeSession(
        { accessToken: 'token_alpha_123', sessionVersion: 1 },
        userId,
        conn1
      );

      ZerodhaCredentialManager.setRuntimeSession(
        { accessToken: 'token_beta_456', sessionVersion: 1 },
        userId,
        conn2
      );

      const sess1 = ZerodhaCredentialManager.getActiveAccessToken(userId, conn1);
      const sess2 = ZerodhaCredentialManager.getActiveAccessToken(userId, conn2);

      assert.equal(sess1, 'token_alpha_123', 'Connection 1 session matches token_alpha_123');
      assert.equal(sess2, 'token_beta_456', 'Connection 2 session matches token_beta_456');

      // Invalidate conn1 only
      await ZerodhaCredentialManager.handleTokenException(userId, 1, conn1);

      const sess1After = ZerodhaCredentialManager.getActiveAccessToken(userId, conn1);
      const sess2After = ZerodhaCredentialManager.getActiveAccessToken(userId, conn2);

      assert.equal(sess1After, null, 'Connection 1 session evicted after token exception');
      assert.equal(sess2After, 'token_beta_456', 'Connection 2 session remains active and isolated');

      console.log('  ✓ PASSED: Zerodha session caching correctly scoped and isolated by userId + connectionId.');
    }

    // --------------------------------------------------------------------------
    // TEST 4: Encryption/Decryption Connection Binding & Migration Fallback
    // --------------------------------------------------------------------------
    console.log('\n[Test 4] Encryption Binding to Broker & Connection with Migration Fallback');
    {
      const userId = 'user_migration_test';
      const provider = 'zerodha';
      const connId = 'conn_migration';

      // 1. Connection-bound payload
      const boundPayload = CryptoService.encrypt('bound_secret_data', userId, provider, connId);
      const decryptedBound = CryptoService.decrypt(boundPayload, userId, provider, connId);
      assert.equal(decryptedBound, 'bound_secret_data', 'Connection-bound decryption succeeds');

      // Attempting to decrypt bound payload with WRONG connectionId must fail
      assert.throws(
        () => CryptoService.decrypt(boundPayload, userId, provider, 'wrong_conn'),
        DecryptionError,
        'Decrypting with mismatched connectionId fails'
      );

      // 2. Legacy payload (encrypted without connectionId in AAD)
      const legacyPayload = CryptoService.encrypt('legacy_secret_data', userId, provider);
      // Decrypting legacy payload WITH connectionId should fall back to legacy AAD and succeed
      const decryptedLegacy = CryptoService.decrypt(legacyPayload, userId, provider, connId);
      assert.equal(decryptedLegacy, 'legacy_secret_data', 'Backward-compatible migration decrypts legacy payload');

      console.log('  ✓ PASSED: Encryption binding to connection and backward-compatible migration verified.');
    }

    console.log('\n=== ALL CREDENTIAL SECURITY CORRECTIONS TESTS PASSED SUCCESSFULLY ===');
  } finally {
    process.env = originalEnv;
  }
}

runSecurityCorrectionsSuite().catch(err => {
  console.error('\n❌ TEST SUITE FAILED:', err);
  process.exit(1);
});
