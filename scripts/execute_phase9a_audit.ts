import { ServerRiskStore, DEFAULT_ACCOUNT_ID, DEFAULT_ANGELONE_ACCOUNT_ID } from '../server/risk/store';
import { liveAngelOneAdapter } from '../server/brokers/angelone/liveAdapter';

async function performPhase9AAudit() {
  console.log('================================================================');
  console.log('MONKTRADES PHASE 9A: PRODUCTION HEALTH & RISK-CONTROL AUDIT');
  console.log('================================================================');

  const userId = 'anirudha.prabhune@gmail.com';

  // 1. Live State Inspection (Angel One)
  console.log('1. Reading Authoritative Persisted Risk Configuration...');
  const angelConfig = await ServerRiskStore.getConfig(userId, DEFAULT_ANGELONE_ACCOUNT_ID);
  console.log('   [Angel One Config]');
  console.log('     accountId:', angelConfig.accountId);
  console.log('     broker:', angelConfig.broker);
  console.log('     executionMode:', angelConfig.executionMode);
  console.log('     dailyLossLimit: ₹' + angelConfig.dailyLossLimit);
  console.log('     warningThreshold1: ' + angelConfig.warningThreshold1 + '% (₹' + (angelConfig.dailyLossLimit * angelConfig.warningThreshold1 / 100) + ')');
  console.log('     warningThreshold2: ' + angelConfig.warningThreshold2 + '% (₹' + (angelConfig.dailyLossLimit * angelConfig.warningThreshold2 / 100) + ')');
  console.log('     lockDurationMinutes:', angelConfig.lockDurationMinutes);

  // 2. Live Risk Session Inspection (Angel One)
  console.log('\n2. Reading Current Authoritative Risk Session...');
  const angelSession = await ServerRiskStore.getSession(userId, undefined, DEFAULT_ANGELONE_ACCOUNT_ID);
  console.log('   [Angel One Session]');
  console.log('     tradingDate:', angelSession.tradingDate);
  console.log('     state:', angelSession.state);
  console.log('     executionMode:', angelSession.executionMode);
  console.log('     isBreached:', angelSession.isBreached);
  console.log('     currentPnl: ₹' + angelSession.currentPnl);
  console.log('     lossAmount: ₹' + angelSession.lossAmount);
  console.log('     lastEvaluatedAt:', angelSession.lastEvaluatedAt);

  // 3. Live State Inspection (Zerodha - Isolation Check)
  console.log('\n3. Reading Zerodha Authoritative State (Isolation Verification)...');
  const zerodhaConfig = await ServerRiskStore.getConfig(userId, DEFAULT_ACCOUNT_ID);
  const zerodhaSession = await ServerRiskStore.getSession(userId, undefined, DEFAULT_ACCOUNT_ID);
  console.log('   [Zerodha Config & Session]');
  console.log('     zerodha.executionMode:', zerodhaConfig.executionMode);
  console.log('     zerodha.dailyLossLimit: ₹' + zerodhaConfig.dailyLossLimit);
  console.log('     zerodha.sessionState:', zerodhaSession.state);

  // 4. Connection Status Inspection
  console.log('\n4. Checking Angel One Live Adapter Connection Status...');
  const connStatus = await liveAngelOneAdapter.getConnectionStatus(userId);
  console.log('   [Angel One Connection Status]');
  console.log('     providerId:', liveAngelOneAdapter.providerId);
  console.log('     status:', connStatus.status);
  console.log('     authenticated:', connStatus.authenticated ?? false);
  console.log('     configured:', connStatus.configured ?? false);

  console.log('\n================================================================');
  console.log('PHASE 9A LIVE AUDIT INSPECTION COMPLETE');
  console.log('================================================================');
}

performPhase9AAudit().catch((err) => {
  console.error('Phase 9A audit error:', err);
  process.exit(1);
});
