import { ServerRiskStore, DEFAULT_ACCOUNT_ID } from '../server/risk/store';
import { EnforcementService } from '../server/enforcement/service';
import { getAdminFirestore, enableMockStoreForTesting } from '../server/brokers/zerodha/sessionStore';
import { getTradingDateKolkata } from '../server/risk/engine';
import { DEFAULT_RISK_CONFIG } from '../src/types/risk';

enableMockStoreForTesting(true);
process.env.NODE_ENV = 'test';

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(`ASSERTION FAILED: ${message}`);
  }
}

async function runStage3Tests() {
  console.log('================================================================');
  console.log('TRADING FIREWALL: STAGE 3 MULTI-ACCOUNT RISK STORE TEST SUITE');
  console.log('Authoritative Multi-Account Isolation, Dual-Write & Invariants');
  console.log('================================================================\n');

  // Reset store for clean test isolation
  ServerRiskStore.reset();

  const userId = 'user_stage3_suite';
  const account1 = 'acc_zerodha_primary';
  const account2 = 'acc_zerodha_secondary';
  const today = getTradingDateKolkata(new Date());

  // --------------------------------------------------------------------------
  // TEST 1: Default Account Resolution when omitted
  // --------------------------------------------------------------------------
  console.log('[Test 1] Default Account Resolution when omitted');
  const resolvedDef = await ServerRiskStore.resolveAccountId(userId);
  assert(
    resolvedDef === DEFAULT_ACCOUNT_ID,
    `Expected default account ${DEFAULT_ACCOUNT_ID}, got ${resolvedDef}`
  );
  console.log(`  ✓ PASSED: Omitted account resolves to ${DEFAULT_ACCOUNT_ID}`);

  // Explicit account resolution preserves custom account
  const resolvedCustom = await ServerRiskStore.resolveAccountId(userId, account1);
  assert(
    resolvedCustom === account1,
    `Expected custom account ${account1}, got ${resolvedCustom}`
  );
  console.log(`  ✓ PASSED: Explicit account resolves to ${account1}`);

  // --------------------------------------------------------------------------
  // TEST 2: Account Isolation — Distinct Account Risk Configurations
  // --------------------------------------------------------------------------
  console.log('\n[Test 2] Account Isolation — Distinct Account Risk Configurations');
  ServerRiskStore.reset();

  const configAcc1 = {
    dailyLossLimit: 5000,
    warningThreshold1: 60,
    warningThreshold2: 80,
    lockDurationMinutes: 720,
    lockDurationType: 'FIXED',
    includeRealisedPnl: true,
    includeUnrealisedPnl: true,
    enabled: true,
  };

  const configAcc2 = {
    dailyLossLimit: 25000,
    warningThreshold1: 75,
    warningThreshold2: 90,
    lockDurationMinutes: 720,
    lockDurationType: 'FIXED',
    includeRealisedPnl: true,
    includeUnrealisedPnl: true,
    enabled: true,
  };

  const saveRes1 = await ServerRiskStore.saveConfig(userId, configAcc1, account1);
  assert(saveRes1.success, 'Save config for account1 must succeed');

  const saveRes2 = await ServerRiskStore.saveConfig(userId, configAcc2, account2);
  assert(saveRes2.success, 'Save config for account2 must succeed');

  const retrievedAcc1 = await ServerRiskStore.getConfig(userId, account1);
  const retrievedAcc2 = await ServerRiskStore.getConfig(userId, account2);

  assert(
    retrievedAcc1.dailyLossLimit === 5000,
    `Account1 dailyLossLimit must be 5000, got ${retrievedAcc1.dailyLossLimit}`
  );
  assert(
    retrievedAcc2.dailyLossLimit === 25000,
    `Account2 dailyLossLimit must be 25000, got ${retrievedAcc2.dailyLossLimit}`
  );
  assert(
    retrievedAcc1.lockDurationMinutes === 720,
    `Account1 lock duration must be 720, got ${retrievedAcc1.lockDurationMinutes}`
  );
  assert(
    retrievedAcc2.lockDurationMinutes === 720,
    `Account2 lock duration must be 720, got ${retrievedAcc2.lockDurationMinutes}`
  );
  console.log('  ✓ PASSED: Account 1 and Account 2 maintain strict isolated configs');

  // --------------------------------------------------------------------------
  // TEST 3: Account Isolation — Independent Session Evaluation and Lock State
  // --------------------------------------------------------------------------
  console.log('\n[Test 3] Account Isolation — Independent Session Evaluation and Lock State');
  const testEvalTime = new Date();

  // Breach Account 1 limit (5,000) with 6,000 loss
  const eval1 = await ServerRiskStore.evaluatePnl(userId, -6000, testEvalTime, account1);
  assert(eval1.session.state === 'LOCKED', 'Account 1 session must be LOCKED');
  assert(eval1.session.isBreached === true, 'Account 1 isBreached must be true');

  // Account 2 limit is 25,000; evaluate with 6,000 loss -> should be ALLOW or WARNING, NOT LOCKED
  const eval2 = await ServerRiskStore.evaluatePnl(userId, -6000, testEvalTime, account2);
  assert(eval2.session.state !== 'LOCKED', 'Account 2 session must NOT be locked by Account 1 breach');
  assert(eval2.session.isBreached === false, 'Account 2 isBreached must be false');

  // Check lock status independently
  const todayDate = getTradingDateKolkata(testEvalTime);
  const lockStatusAcc1 = await ServerRiskStore.getLockStatus(userId, account1, todayDate);
  const lockStatusAcc2 = await ServerRiskStore.getLockStatus(userId, account2, todayDate);

  assert(lockStatusAcc1.locked === true, 'Account 1 lock status must be locked');
  assert(lockStatusAcc1.state === 'LOCKED', 'Account 1 state must be LOCKED');
  assert(lockStatusAcc2.locked === false, 'Account 2 lock status must NOT be locked');
  assert(lockStatusAcc2.state !== 'LOCKED', 'Account 2 state must NOT be LOCKED');
  console.log('  ✓ PASSED: Breach on Account 1 leaves Account 2 fully functional and unlocked');

  // --------------------------------------------------------------------------
  // TEST 4: Dual-Write Consistency & Legacy Compatibility
  // --------------------------------------------------------------------------
  console.log('\n[Test 4] Dual-Write Consistency & Legacy Caller Compatibility');
  ServerRiskStore.reset();

  const legacyCallerConfig = {
    dailyLossLimit: 12000,
    warningThreshold1: 70,
    warningThreshold2: 90,
    lockDurationMinutes: 720,
    enabled: true,
  };

  // Caller omitting accountId (legacy caller)
  const legacySaveRes = await ServerRiskStore.saveConfig(userId, legacyCallerConfig);
  assert(legacySaveRes.success, 'Legacy saveConfig must succeed');

  // Legacy getConfig without accountId
  const legacyGetConfig = await ServerRiskStore.getConfig(userId);
  assert(
    legacyGetConfig.dailyLossLimit === 12000,
    `Legacy getConfig must retrieve 12000, got ${legacyGetConfig.dailyLossLimit}`
  );

  // Explicit query with DEFAULT_ACCOUNT_ID must retrieve same config (dual-write consistency)
  const defaultAccConfig = await ServerRiskStore.getConfig(userId, DEFAULT_ACCOUNT_ID);
  assert(
    defaultAccConfig.dailyLossLimit === 12000,
    `Default account config must match dual-written value 12000, got ${defaultAccConfig.dailyLossLimit}`
  );

  // Evaluate via legacy signature (no accountId)
  const legacyEval = await ServerRiskStore.evaluatePnl(userId, -15000, testEvalTime);
  assert(legacyEval.session.state === 'LOCKED', 'Legacy evaluation must produce LOCKED state on breach');

  // Both legacy session getter and default account session getter must observe the lock
  const legacySession = await ServerRiskStore.getSession(userId, todayDate);
  const defaultAccSession = await ServerRiskStore.getSession(userId, todayDate, DEFAULT_ACCOUNT_ID);

  assert(legacySession.state === 'LOCKED', 'Legacy getSession must return LOCKED');
  assert(defaultAccSession.state === 'LOCKED', 'Default account getSession must return LOCKED');
  assert(
    legacySession.lockedAt === defaultAccSession.lockedAt,
    'LockedAt timestamp must match across legacy and default account views'
  );
  console.log('  ✓ PASSED: Dual-write preserves complete backward compatibility for legacy callers');

  // --------------------------------------------------------------------------
  // TEST 5: LOCKED Immutability Guard per Account
  // --------------------------------------------------------------------------
  console.log('\n[Test 5] LOCKED Immutability Guard per Account');
  // Explicitly configure and lock Account 1
  await ServerRiskStore.saveConfig(userId, configAcc1, account1);
  await ServerRiskStore.evaluatePnl(userId, -6000, testEvalTime, account1);

  // Attempting to loosen loss limit on locked Account 1 must be rejected with RISK_CONFIG_LOCKED
  const mutationAttemptAcc1 = await ServerRiskStore.saveConfig(
    userId,
    { ...configAcc1, dailyLossLimit: 50000 },
    account1
  );
  assert(
    mutationAttemptAcc1.success === false,
    'Config mutation for locked Account 1 must be rejected'
  );
  assert(
    mutationAttemptAcc1.code === 'RISK_CONFIG_LOCKED',
    `Expected RISK_CONFIG_LOCKED, got ${mutationAttemptAcc1.code}`
  );

  // Meanwhile, Account 2 is NOT locked. Updating config on Account 2 must succeed!
  const mutationAttemptAcc2 = await ServerRiskStore.saveConfig(
    userId,
    { ...configAcc2, dailyLossLimit: 30000 },
    account2
  );
  assert(
    mutationAttemptAcc2.success === true,
    'Config mutation for unlocked Account 2 must succeed even while Account 1 is locked'
  );
  const updatedAcc2Config = await ServerRiskStore.getConfig(userId, account2);
  assert(
    updatedAcc2Config.dailyLossLimit === 30000,
    `Account 2 updated limit must be 30000, got ${updatedAcc2Config.dailyLossLimit}`
  );
  console.log('  ✓ PASSED: Immutability guard enforces lock per-account without blocking unlocked accounts');

  // --------------------------------------------------------------------------
  // TEST 6: Session Reset Scoping
  // --------------------------------------------------------------------------
  console.log('\n[Test 6] Session Reset Scoping');
  // Reset session on Account 1 only
  const resetResAcc1 = await ServerRiskStore.resetSession(userId, account1);
  assert(resetResAcc1.state === 'ALLOW', 'Reset session on Account 1 must return ALLOW baseline');

  const afterResetStatusAcc1 = await ServerRiskStore.getLockStatus(userId, account1);
  assert(afterResetStatusAcc1.locked === false, 'Account 1 must now be unlocked');

  // Dual-reset on legacy path also works cleanly
  const resetLegacy = await ServerRiskStore.resetSession(userId);
  assert(resetLegacy.state === 'ALLOW', 'Legacy resetSession must return ALLOW baseline');
  console.log('  ✓ PASSED: Session reset operations scoped correctly');

  // --------------------------------------------------------------------------
  // TEST 7: Enforcement Service Integration with ServerRiskStore
  // --------------------------------------------------------------------------
  console.log('\n[Test 7] Enforcement Service Integration with ServerRiskStore');
  ServerRiskStore.reset();

  // Evaluate positive P&L on default account
  await ServerRiskStore.evaluatePnl(userId, 500, testEvalTime);
  const enforcementStatusAllow = await EnforcementService.getEnforcementState(userId, testEvalTime);
  assert(enforcementStatusAllow.isLocked === false, 'Enforcement must report isLocked=false for positive P&L');
  assert(enforcementStatusAllow.riskState === 'ALLOW', 'Enforcement must report ALLOW');

  // Evaluate breach on default account
  await ServerRiskStore.evaluatePnl(userId, -20000, testEvalTime);
  const enforcementStatusLocked = await EnforcementService.getEnforcementState(userId, testEvalTime);
  assert(enforcementStatusLocked.isLocked === true, 'Enforcement must report isLocked=true after breach');
  assert(enforcementStatusLocked.riskState === 'LOCKED', 'Enforcement must report LOCKED');
  console.log('  ✓ PASSED: EnforcementService seamlessly observes multi-account default and lock states');

  // --------------------------------------------------------------------------
  // TEST 8: Validation Error Handling in SaveConfig
  // --------------------------------------------------------------------------
  console.log('\n[Test 8] Validation Error Handling in SaveConfig');
  const invalidConfig = {
    dailyLossLimit: -500, // Invalid negative loss limit
    warningThreshold1: 120, // Invalid threshold > 100
  };
  const invalidSaveRes = await ServerRiskStore.saveConfig(userId, invalidConfig, account1);
  assert(invalidSaveRes.success === false, 'Invalid config must fail validation');
  assert(invalidSaveRes.errors !== undefined && invalidSaveRes.errors.length > 0, 'Validation errors must be returned');
  console.log('  ✓ PASSED: Validation errors handled deterministically without mutation');

  console.log('\n================================================================');
  console.log('ALL 8 STAGE 3 MULTI-ACCOUNT RISK STORE TESTS PASSED (8/8)');
  console.log('================================================================');
}

runStage3Tests()
  .catch((err) => {
    console.error('\nSTAGE 3 MULTI-ACCOUNT RISK STORE TESTS FAILED:', err);
    process.exit(1);
  });
