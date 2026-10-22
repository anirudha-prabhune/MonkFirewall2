import { ServerRiskStore, DEFAULT_ACCOUNT_ID, DEFAULT_ANGELONE_ACCOUNT_ID } from '../server/risk/store';
import { liveAngelOneAdapter } from '../server/brokers/angelone/liveAdapter';
import { enableMockStoreForTesting, setAdminFirestoreForTesting, getAdminFirestore } from '../server/brokers/zerodha/sessionStore';
import { DEFAULT_ANGELONE_RISK_CONFIG, DEFAULT_RISK_CONFIG } from '../src/types/risk';

async function executeControlledActivation() {
  console.log('================================================================');
  console.log('MONKTRADES PHASE 8E: CONTROLLED ANGEL ONE ENFORCEMENT ACTIVATION');
  console.log('================================================================');

  const operatorEmail = 'anirudha.prabhune@gmail.com';
  let operatorUserId = operatorEmail;
  const adminDb = getAdminFirestore();
  if (adminDb) {
    const userSnap = await adminDb.collection('users').where('email', '==', operatorEmail).get();
    if (!userSnap.empty) {
      operatorUserId = userSnap.docs[0].id;
      console.log(`Resolved operator ${operatorEmail} -> UID: ${operatorUserId}`);
    }
  }

  // 1. PRECONDITION 1: Verify Pre-Activation Configuration for Angel One
  console.log('Step 1: Reading pre-activation risk configuration for Angel One...');
  const initialAngelConfig = await ServerRiskStore.getConfig(operatorUserId, DEFAULT_ANGELONE_ACCOUNT_ID);
  console.log('  Current Angel One Mode:', initialAngelConfig.executionMode);
  console.log('  Current Angel One Loss Limit: ₹' + initialAngelConfig.dailyLossLimit);

  // 2. PRECONDITION 2: Verify Zerodha Pre-Activation Configuration
  const initialZerodhaConfig = await ServerRiskStore.getConfig(operatorUserId, DEFAULT_ACCOUNT_ID);
  console.log('  Zerodha Mode:', initialZerodhaConfig.executionMode);
  console.log('  Zerodha Loss Limit: ₹' + initialZerodhaConfig.dailyLossLimit);

  // 3. ACTIVATION: Perform controlled authorized activation via ServerRiskStore.saveConfig
  console.log('\nStep 2: Executing controlled ENFORCE activation for acc_mt_angelone_default...');
  const activationPayload = {
    ...initialAngelConfig,
    dailyLossLimit: initialAngelConfig.dailyLossLimit || 10000,
    warningThreshold1: initialAngelConfig.warningThreshold1 || 70,
    warningThreshold2: initialAngelConfig.warningThreshold2 || 90,
    lockDurationMinutes: initialAngelConfig.lockDurationMinutes || 720,
    lockDurationType: initialAngelConfig.lockDurationType || 'FIXED',
    executionMode: 'ENFORCE',
    broker: 'angelone',
    accountId: DEFAULT_ANGELONE_ACCOUNT_ID,
    scope: 'ACCOUNT',
  };

  const activationResult = await ServerRiskStore.saveConfig(
    operatorUserId,
    activationPayload,
    DEFAULT_ANGELONE_ACCOUNT_ID
  );

  if (!activationResult.success || !activationResult.config) {
    console.error('  ✗ Activation Failed:', activationResult.errors);
    process.exit(1);
  }

  console.log('  ✓ Activation Request Succeeded via Authorized Application API Path.');

  // 4. POST-ACTIVATION VERIFICATION: Read-Back Verification
  console.log('\nStep 3: Performing Post-Activation Verification...');
  const verifiedAngelConfig = await ServerRiskStore.getConfig(operatorUserId, DEFAULT_ANGELONE_ACCOUNT_ID);
  console.log('  Verified Angel One Mode:', verifiedAngelConfig.executionMode);
  console.log('  Verified Angel One Loss Limit: ₹' + verifiedAngelConfig.dailyLossLimit);

  if (verifiedAngelConfig.executionMode !== 'ENFORCE') {
    console.error('  ✗ Verification Failed: executionMode is not ENFORCE');
    process.exit(1);
  }

  // Verify Zerodha remains completely unaffected
  const verifiedZerodhaConfig = await ServerRiskStore.getConfig(operatorUserId, DEFAULT_ACCOUNT_ID);
  console.log('  Verified Zerodha Mode:', verifiedZerodhaConfig.executionMode);
  console.log('  Verified Zerodha Loss Limit: ₹' + verifiedZerodhaConfig.dailyLossLimit);

  if (verifiedZerodhaConfig.executionMode !== 'ENFORCE') {
    console.error('  ✗ Verification Failed: Zerodha mode was altered');
    process.exit(1);
  }

  // Verify Risk Session State
  const angelSession = await ServerRiskStore.getSession(operatorUserId, undefined, DEFAULT_ANGELONE_ACCOUNT_ID);
  console.log('  Angel One Session State:', angelSession.state);
  console.log('  Angel One Session Execution Mode:', angelSession.executionMode);

  console.log('\n================================================================');
  console.log('PHASE 8E CONTROLLED ACTIVATION COMPLETED & VERIFIED SUCCESSFULLY');
  console.log('================================================================');
}

executeControlledActivation().catch((err) => {
  console.error('Phase 8E execution error:', err);
  process.exit(1);
});
