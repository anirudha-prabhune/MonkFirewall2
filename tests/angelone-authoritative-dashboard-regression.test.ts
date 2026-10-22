import { strict as assert } from 'assert';
import { ServerRiskStore, DEFAULT_ACCOUNT_ID, DEFAULT_ANGELONE_ACCOUNT_ID } from '../server/risk/store';
import { EnforcementService } from '../server/enforcement/service';
import { setAdminFirestoreForTesting } from '../server/brokers/zerodha/sessionStore';
import { DEFAULT_ANGELONE_RISK_CONFIG, DEFAULT_RISK_CONFIG } from '../src/types/risk';
import { getApps, initializeApp, cert, getApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import firebaseConfig from '../firebase-applet-config.json' with { type: 'json' };
import fs from 'fs';

async function runRegressionSuite() {
  console.log('================================================================');
  console.log('REGRESSION TEST: ANGEL ONE AUTHORITATIVE EXECUTION MODE & LIMIT');
  console.log('Proves acc_mt_angelone_default displays ENFORCE & Daily Loss Limit');
  console.log('Proves acc_mt_zerodha_default remains completely unchanged');
  console.log('================================================================\n');

  // Initialize and bind authoritative Firestore Admin
  if (getApps().length === 0) {
    const appOptions: any = {
      projectId: firebaseConfig.projectId,
    };
    if (process.env.FIREBASE_SERVICE_ACCOUNT_KEY) {
      try {
        const raw = process.env.FIREBASE_SERVICE_ACCOUNT_KEY.trim();
        if (raw.startsWith('{')) {
          appOptions.credential = cert(JSON.parse(raw));
        } else if (fs.existsSync(raw)) {
          appOptions.credential = cert(JSON.parse(fs.readFileSync(raw, 'utf8')));
        }
      } catch {}
    } else if (process.env.GOOGLE_APPLICATION_CREDENTIALS && fs.existsSync(process.env.GOOGLE_APPLICATION_CREDENTIALS)) {
      try {
        appOptions.credential = cert(JSON.parse(fs.readFileSync(process.env.GOOGLE_APPLICATION_CREDENTIALS, 'utf8')));
      } catch {}
    }
    initializeApp(appOptions);
  }
  const dbId = (firebaseConfig as any).firestoreDatabaseId || '(default)';
  const adminDb = getFirestore(getApp(), dbId);
  setAdminFirestoreForTesting(adminDb);
  ServerRiskStore.reset();

  // Deployed production user ID for operator
  const deployedUserId = '1v16OuVKgIeucBG2yibxwoi2zQQ2';

  // --------------------------------------------------------------------------
  // TEST 1: Authoritative Angel One Configuration Resolution
  // --------------------------------------------------------------------------
  console.log('[Test 1] Authoritative Configuration Resolution for acc_mt_angelone_default');
  {
    const angelConfig = await ServerRiskStore.getConfig(deployedUserId, DEFAULT_ANGELONE_ACCOUNT_ID);

    assert.equal(angelConfig.accountId, DEFAULT_ANGELONE_ACCOUNT_ID, 'AccountId must be acc_mt_angelone_default');
    assert.equal(angelConfig.broker, 'angelone', 'Broker must be angelone');
    assert.equal(angelConfig.executionMode, 'ENFORCE', 'Authoritative executionMode must be ENFORCE, not OBSERVE_ONLY');
    assert.equal(angelConfig.dailyLossLimit, 500, 'Authoritative dailyLossLimit must match persisted limit (₹500)');
    assert.equal(angelConfig.warningThreshold1, 70, 'Warning threshold 1 must be 70%');
    assert.equal(angelConfig.warningThreshold2, 90, 'Warning threshold 2 must be 90%');
    assert.equal(angelConfig.enabled, true, 'Risk firewall must be enabled');

    console.log('  ✓ PASSED: Angel One account resolves authoritative mode: ENFORCE and limit: ₹500');
  }

  // --------------------------------------------------------------------------
  // TEST 2: Multi-Account Isolation: Zerodha Account Unchanged
  // --------------------------------------------------------------------------
  console.log('\n[Test 2] Multi-Account Isolation: Zerodha Account Unchanged');
  {
    const zerodhaConfig = await ServerRiskStore.getConfig(deployedUserId, DEFAULT_ACCOUNT_ID);

    assert.equal(zerodhaConfig.accountId, DEFAULT_ACCOUNT_ID, 'AccountId must be acc_mt_zerodha_default');
    assert.equal(zerodhaConfig.broker, 'zerodha', 'Broker must be zerodha');
    assert.equal(zerodhaConfig.executionMode, 'ENFORCE', 'Zerodha executionMode must remain ENFORCE');
    assert.equal(zerodhaConfig.dailyLossLimit, 1000, 'Zerodha dailyLossLimit must remain unchanged at ₹1,000');
    assert.equal(zerodhaConfig.warningThreshold1, 70, 'Warning threshold 1 must be 70%');
    assert.equal(zerodhaConfig.warningThreshold2, 90, 'Warning threshold 2 must be 90%');
    assert.equal(zerodhaConfig.enabled, true, 'Zerodha risk firewall must be enabled');

    console.log('  ✓ PASSED: Zerodha account remains strictly isolated with limit: ₹1,000 and mode: ENFORCE');
  }

  // --------------------------------------------------------------------------
  // TEST 3: EnforcementService Account Binding
  // --------------------------------------------------------------------------
  console.log('\n[Test 3] EnforcementService State & Account Binding');
  {
    const angelEnforcement = await EnforcementService.getEnforcementState(
      deployedUserId,
      new Date(),
      DEFAULT_ANGELONE_ACCOUNT_ID
    );
    assert.equal(angelEnforcement.accountId, DEFAULT_ANGELONE_ACCOUNT_ID, 'EnforcementState binds to Angel One account');
    assert.equal(angelEnforcement.authority, 'server');

    const zerodhaEnforcement = await EnforcementService.getEnforcementState(
      deployedUserId,
      new Date(),
      DEFAULT_ACCOUNT_ID
    );
    assert.equal(zerodhaEnforcement.accountId, DEFAULT_ACCOUNT_ID, 'EnforcementState binds to Zerodha account');
    assert.equal(zerodhaEnforcement.authority, 'server');

    console.log('  ✓ PASSED: Server-authoritative enforcement binds independently to respective accounts');
  }

  // --------------------------------------------------------------------------
  // TEST 4: Frontend Dashboard Value Derivation Simulation
  // --------------------------------------------------------------------------
  console.log('\n[Test 4] Frontend Dashboard Value Derivation Simulation');
  {
    // Simulate DashboardOverview logic for Angel One
    const angelConfig = await ServerRiskStore.getConfig(deployedUserId, DEFAULT_ANGELONE_ACCOUNT_ID);
    const angelProtectionLabel = !angelConfig.enabled ? 'Disabled' : angelConfig.executionMode || 'ENFORCE';
    const angelDailyLossLimit = angelConfig.dailyLossLimit;

    assert.equal(angelProtectionLabel, 'ENFORCE', 'Dashboard Protection pill must display ENFORCE');
    assert.equal(angelDailyLossLimit, 500, 'Dashboard Daily Loss Limit pillar must display 500');

    // Simulate DashboardOverview logic for Zerodha
    const zerodhaConfig = await ServerRiskStore.getConfig(deployedUserId, DEFAULT_ACCOUNT_ID);
    const zerodhaProtectionLabel = !zerodhaConfig.enabled ? 'Disabled' : zerodhaConfig.executionMode || 'ENFORCE';
    const zerodhaDailyLossLimit = zerodhaConfig.dailyLossLimit;

    assert.equal(zerodhaProtectionLabel, 'ENFORCE', 'Dashboard Protection pill must display ENFORCE for Zerodha');
    assert.equal(zerodhaDailyLossLimit, 1000, 'Dashboard Daily Loss Limit pillar must display 1000 for Zerodha');

    console.log('  ✓ PASSED: Dashboard value derivation produces authoritative ENFORCE and ₹500 for Angel One, and ENFORCE and ₹1,000 for Zerodha');
  }

  // --------------------------------------------------------------------------
  // TEST 5: Default Fallback Invariance (Fresh Account Without Overrides)
  // --------------------------------------------------------------------------
  console.log('\n[Test 5] Default Fallback Invariance (Fresh User Account)');
  {
    const freshUserId = 'fresh_regression_trader_test';
    const freshAngelConfig = await ServerRiskStore.getConfig(freshUserId, DEFAULT_ANGELONE_ACCOUNT_ID);
    assert.equal(freshAngelConfig.executionMode, 'ENFORCE', 'Default Angel One must be ENFORCE');
    assert.equal(freshAngelConfig.dailyLossLimit, DEFAULT_ANGELONE_RISK_CONFIG.dailyLossLimit, 'Default Angel One limit is ₹10,000');

    const freshZerodhaConfig = await ServerRiskStore.getConfig(freshUserId, DEFAULT_ACCOUNT_ID);
    assert.equal(freshZerodhaConfig.executionMode, 'ENFORCE', 'Default Zerodha must be ENFORCE');
    assert.equal(freshZerodhaConfig.dailyLossLimit, DEFAULT_RISK_CONFIG.dailyLossLimit, 'Default Zerodha limit is ₹10,000');

    console.log('  ✓ PASSED: Fresh accounts with no persisted overrides correctly fall back to default ENFORCE');
  }

  console.log('\n================================================================');
  console.log('ALL REGRESSION TESTS PASSED (5/5)');
  console.log('================================================================\n');
}

runRegressionSuite().catch((err) => {
  console.error('\nRegression test failed:', err);
  process.exit(1);
});
