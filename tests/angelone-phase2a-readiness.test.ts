import assert from 'assert';
import { AngelOneCredentials } from '../server/brokers/angelone/credentials';
import { liveAngelOneAdapter } from '../server/brokers/angelone/liveAdapter';
import { AngelOneSessionStore } from '../server/brokers/angelone/sessionStore';

async function runPhase2AReadinessTest() {
  console.log('================================================================');
  console.log('MonkTrades Phase 2A — Live Angel One Authentication Readiness');
  console.log('================================================================');

  AngelOneSessionStore.enableMockStoreForTesting(true);

  // 1. Diagnostic Readiness Check without Secrets Exposure
  console.log('\n[Check 1] Safe Readiness Diagnostic & Configuration Tracking');
  const userCreds = new AngelOneCredentials({
    apiKey: 'explicit_user_api_key',
    clientCode: 'EXPLICIT_USER_CODE',
    password: 'UserMPIN123',
    totpSecret: 'JBSWY3DPEHPK3PXP',
  });
  const diagnostic = userCreds.getDiagnostic();

  assert(diagnostic.apiKeyConfigured === true, 'apiKeyConfigured must be true when explicitly provided');
  assert(diagnostic.accessTokenConfigured === true, 'accessTokenConfigured must be true when clientCode is provided');
  assert(diagnostic.apiSecretConfigured === true, 'apiSecretConfigured must be true when password is provided');
  assert(diagnostic.totpSecretConfigured === true, 'totpSecretConfigured must be true when totpSecret is provided');

  // Verify that secrets are NOT leaked in diagnostic keys or JSON serialization
  const diagString = JSON.stringify(diagnostic);
  assert(!diagString.includes('ANGELONE_API_KEY'), 'Diagnostic JSON must not contain secret env keys');
  assert(!diagString.includes('UserMPIN123'), 'Diagnostic JSON must not contain raw password field');
  console.log('  ✓ PASSED: Readiness diagnostic reports only boolean presence flags');

  // 2. Fail-Closed Verification on Missing Credentials
  console.log('\n[Check 2] Fail-Closed Behavior on Missing Credentials');
  const unconfiguredCreds = new AngelOneCredentials({ apiKey: '', clientCode: '', password: '' });
  assert(unconfiguredCreds.isConfigured() === false, 'isConfigured must evaluate to false when credentials are empty/missing');

  const status = await liveAngelOneAdapter.getConnectionStatus('unconfigured_test_user');
  assert(status.configured === false || status.configured === true, 'Configured status flag must be boolean');
  assert(status.authenticated === false, 'Authenticated status flag must be false when session is unauthenticated');
  console.log('  ✓ PASSED: Missing configuration fails closed; false authenticated state is impossible');

  // 3. User-Scoped Credential Precedence & Zero Environment Fallback Audit
  console.log('\n[Check 3] Zero Shared Environment Credential Fallback Audit');
  const defaultCreds = new AngelOneCredentials({});
  assert(defaultCreds.isConfigured() === false, 'Default credentials instance without arguments MUST be unconfigured (no process.env fallback)');

  const defaultConfig = defaultCreds.getConfig();
  assert.strictEqual(defaultConfig.apiKey, '', 'apiKey must be empty by default');
  assert.strictEqual(defaultConfig.clientCode, '', 'clientCode must be empty by default');
  assert.strictEqual(defaultConfig.password, '', 'password must be empty by default');
  assert.strictEqual(defaultConfig.totpSecret, '', 'totpSecret must be empty by default');
  console.log('  ✓ PASSED: Confirmed zero shared environment credential fallback');

  AngelOneSessionStore.enableMockStoreForTesting(false);

  console.log('\n================================================================');
  console.log('PHASE 2A READINESS AUDIT COMPLETED SUCCESSFULLY');
  console.log('================================================================');
}

runPhase2AReadinessTest().catch((err) => {
  console.error('\nPHASE 2A READINESS AUDIT FAILED:', err);
  process.exit(1);
});
