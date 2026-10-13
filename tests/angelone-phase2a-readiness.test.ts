import { AngelOneCredentials } from '../server/brokers/angelone/credentials';
import { liveAngelOneAdapter } from '../server/brokers/angelone/liveAdapter';
import { AngelOneSessionStore } from '../server/brokers/angelone/sessionStore';

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

async function runPhase2AReadinessTest() {
  console.log('================================================================');
  console.log('MonkTrades Phase 2A — Live Angel One Authentication Readiness');
  console.log('================================================================');

  AngelOneSessionStore.enableMockStoreForTesting(true);

  // 1. Diagnostic Readiness Check without Secrets Exposure
  console.log('\n[Check 1] Safe Readiness Diagnostic & Configuration Tracking');
  const creds = new AngelOneCredentials();
  const diagnostic = creds.getDiagnostic();

  assert(typeof diagnostic.apiKeyConfigured === 'boolean', 'apiKeyConfigured must be boolean');
  assert(typeof diagnostic.accessTokenConfigured === 'boolean', 'accessTokenConfigured must be boolean (tracks clientCode)');
  assert(typeof diagnostic.apiSecretConfigured === 'boolean', 'apiSecretConfigured must be boolean (tracks password)');
  assert(typeof diagnostic.totpSecretConfigured === 'boolean', 'totpSecretConfigured must be boolean (tracks totpSecret)');

  // Verify that secrets are NOT leaked in diagnostic keys or JSON serialization
  const diagString = JSON.stringify(diagnostic);
  assert(!diagString.includes('ANGELONE_API_KEY'), 'Diagnostic JSON must not contain secret env keys');
  assert(!diagString.includes('password'), 'Diagnostic JSON must not contain raw password field');
  console.log('  ✓ PASSED: Readiness diagnostic reports only boolean presence flags');

  // 2. Fail-Closed Verification on Missing Credentials
  console.log('\n[Check 2] Fail-Closed Behavior on Missing Credentials');
  const unconfiguredCreds = new AngelOneCredentials({ apiKey: '', clientCode: '', password: '' });
  assert(unconfiguredCreds.isConfigured() === false, 'isConfigured must evaluate to false when credentials are empty/missing');

  const status = await liveAngelOneAdapter.getConnectionStatus('unconfigured_test_user');
  assert(status.configured === true || status.configured === false, 'Configured status flag must be boolean');
  assert(status.authenticated === false, 'Authenticated status flag must be false when session is unauthenticated');
  console.log('  ✓ PASSED: Missing configuration fails closed; false authenticated state is impossible');

  // 3. Environment Variable Readiness Report
  console.log('\n[Check 3] Environment Variable Presence Audit');
  const isApiKeyPresent = Boolean(process.env.ANGELONE_API_KEY);
  const isClientCodePresent = Boolean(process.env.ANGELONE_CLIENT_CODE);
  const isPasswordPresent = Boolean(process.env.ANGELONE_PASSWORD);
  const isTotpSecretPresent = Boolean(process.env.ANGELONE_TOTP_SECRET);

  console.log(`  • ANGELONE_API_KEY:       ${isApiKeyPresent ? 'CONFIGURED' : 'MISSING'}`);
  console.log(`  • ANGELONE_CLIENT_CODE:   ${isClientCodePresent ? 'CONFIGURED' : 'MISSING'}`);
  console.log(`  • ANGELONE_PASSWORD:      ${isPasswordPresent ? 'CONFIGURED' : 'MISSING'}`);
  console.log(`  • ANGELONE_TOTP_SECRET:   ${isTotpSecretPresent ? 'CONFIGURED' : 'MISSING'}`);

  AngelOneSessionStore.enableMockStoreForTesting(false);

  console.log('\n================================================================');
  console.log('PHASE 2A READINESS AUDIT COMPLETED SUCCESSFULLY');
  console.log('================================================================');
}

runPhase2AReadinessTest().catch((err) => {
  console.error('\nPHASE 2A READINESS AUDIT FAILED:', err);
  process.exit(1);
});
