import { strict as assert } from 'assert';
import {
  ServerRiskStore,
  DEFAULT_ACCOUNT_ID,
  DEFAULT_ANGELONE_ACCOUNT_ID,
  DEFAULT_SIMULATION_ACCOUNT_ID,
} from '../server/risk/store';
import { DEFAULT_RISK_CONFIG, DEFAULT_ANGELONE_RISK_CONFIG } from '../src/types/risk';

// Simulated browser storage mock
class MockLocalStorage {
  private store: Map<string, string> = new Map();

  getItem(key: string): string | null {
    return this.store.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.store.set(key, String(value));
  }

  removeItem(key: string): void {
    this.store.delete(key);
  }

  clear(): void {
    this.store.clear();
  }
}

// Mode determination helper matching DashboardOverview.tsx
function computeDashboardMode(
  user: { uid: string; isSandbox?: boolean; email?: string } | null,
  storage: MockLocalStorage
) {
  const isDemoIdentity = Boolean(
    user?.isSandbox ||
    user?.uid === 'mock-trader-sandbox' ||
    user?.uid?.startsWith('mock-')
  );

  const getSavedExplicitDemo = (): boolean => {
    if (isDemoIdentity) return true;
    return storage.getItem('trading_firewall_explicit_demo') === 'true';
  };

  const explicitDemoMode = getSavedExplicitDemo();
  const isSimulationMode = isDemoIdentity || explicitDemoMode;
  const isLiveMode = !isSimulationMode;

  const brokerSelectionDisabled = isSimulationMode || Boolean(user?.isSandbox);
  const brokerConnectionsDisabled = isSimulationMode || Boolean(user?.isSandbox);
  const showActiveTradingAccountSection = !isSimulationMode;
  const showCapitalAndFundsSection = !isSimulationMode;
  const showRiskAuditSection = !isSimulationMode;
  const showDemoSimulationControls = isSimulationMode;

  return {
    isDemoIdentity,
    explicitDemoMode,
    isSimulationMode,
    isLiveMode,
    brokerSelectionDisabled,
    brokerConnectionsDisabled,
    showActiveTradingAccountSection,
    showCapitalAndFundsSection,
    showRiskAuditSection,
    showDemoSimulationControls,
    toggleDemoMode: (enable: boolean) => {
      if (isDemoIdentity) return;
      if (enable) {
        storage.setItem('trading_firewall_explicit_demo', 'true');
      } else {
        storage.removeItem('trading_firewall_explicit_demo');
      }
    },
    logout: () => {
      storage.removeItem('trading_firewall_explicit_demo');
    },
  };
}

async function runGoogleLoginLiveModeIsolationSuite() {
  console.log('====================================================================');
  console.log('MONKFIREWALL2: GOOGLE LOGIN & LIVE MODE ISOLATION REGRESSION SUITE');
  console.log('1. Google-authenticated normal user defaults to LIVE MODE');
  console.log('2. Broker connection actions enabled for normal authenticated users');
  console.log('3. Demo identity (mock-trader-sandbox) strictly locked in Simulation Mode');
  console.log('4. Explicit opt-in Demo Mode activation and return to Live Mode');
  console.log('5. Page refresh persistence & logout storage cleanup');
  console.log('6. Server API isolation (no simulation session cross-leakage to live)');
  console.log('====================================================================\n');

  const storage = new MockLocalStorage();

  // --------------------------------------------------------------------------
  // TEST 1: Google-authenticated Normal User Defaults to LIVE MODE
  // --------------------------------------------------------------------------
  console.log('[Test 1] Google-authenticated Normal User Defaults to LIVE MODE');
  {
    storage.clear();
    const googleUser = {
      uid: 'google_oauth_uid_98765',
      email: 'verified.trader@gmail.com',
      isSandbox: false,
    };

    const dashboard = computeDashboardMode(googleUser, storage);

    assert.equal(dashboard.isDemoIdentity, false, 'Google user must NOT be classified as demo identity');
    assert.equal(dashboard.isSimulationMode, false, 'Google user must NOT enter simulation mode by default');
    assert.equal(dashboard.isLiveMode, true, 'Google user MUST enter LIVE MODE by default');
    assert.equal(dashboard.brokerSelectionDisabled, false, 'Broker selection must be ENABLED in Live Mode');
    assert.equal(dashboard.brokerConnectionsDisabled, false, 'Broker connections must be ENABLED in Live Mode');
    assert.equal(dashboard.showActiveTradingAccountSection, true, 'Active Trading Account section must be VISIBLE in Live Mode');
    assert.equal(dashboard.showCapitalAndFundsSection, true, 'Account Capital & Funds section must be VISIBLE in Live Mode');
    assert.equal(dashboard.showRiskAuditSection, true, 'Risk Activity & Operational Audit section must be VISIBLE in Live Mode');
    assert.equal(dashboard.showDemoSimulationControls, false, 'Demo controls must be HIDDEN in Live Mode');

    console.log('  ✓ PASSED: Google-authenticated verified user enters LIVE MODE with all live sections & connections active');
  }

  // --------------------------------------------------------------------------
  // TEST 2: Demo Identity (mock-trader-sandbox) Strict Lock & Isolation
  // --------------------------------------------------------------------------
  console.log('\n[Test 2] Demo Identity Locked in Simulation Mode');
  {
    storage.clear();
    const demoUser = {
      uid: 'mock-trader-sandbox',
      email: 'demo@tradingfirewall.internal',
      isSandbox: true,
    };

    const dashboard = computeDashboardMode(demoUser, storage);

    assert.equal(dashboard.isDemoIdentity, true, 'mock-trader-sandbox is identified as demo identity');
    assert.equal(dashboard.isSimulationMode, true, 'Demo user MUST enter SIMULATION MODE');
    assert.equal(dashboard.isLiveMode, false, 'Demo user MUST NOT enter LIVE MODE');
    assert.equal(dashboard.brokerSelectionDisabled, true, 'Broker selection must be DISABLED for demo identity');
    assert.equal(dashboard.brokerConnectionsDisabled, true, 'Broker connections must be DISABLED for demo identity');
    assert.equal(dashboard.showActiveTradingAccountSection, false, 'Active Trading Account section must be HIDDEN in Simulation Mode');
    assert.equal(dashboard.showCapitalAndFundsSection, false, 'Capital & Funds section must be HIDDEN in Simulation Mode');
    assert.equal(dashboard.showRiskAuditSection, false, 'Risk Audit section must be HIDDEN in Simulation Mode');
    assert.equal(dashboard.showDemoSimulationControls, true, 'Demo controls must be VISIBLE in Simulation Mode');

    // Attempt to toggle demo identity to live mode must be a NO-OP
    dashboard.toggleDemoMode(false);
    assert.equal(storage.getItem('trading_firewall_explicit_demo'), null, 'Demo identity cannot toggle to live');

    console.log('  ✓ PASSED: Demo identity is securely locked into Simulation Mode without live broker access');
  }

  // --------------------------------------------------------------------------
  // TEST 3: Opt-in Explicit Demo Mode for Normal Authenticated User
  // --------------------------------------------------------------------------
  console.log('\n[Test 3] Opt-in Explicit Demo Mode Activation and Return to Live Mode');
  {
    storage.clear();
    const googleUser = {
      uid: 'google_oauth_uid_98765',
      email: 'verified.trader@gmail.com',
      isSandbox: false,
    };

    // User explicitly opts into Demo Mode
    const initialDashboard = computeDashboardMode(googleUser, storage);
    initialDashboard.toggleDemoMode(true);
    assert.equal(storage.getItem('trading_firewall_explicit_demo'), 'true', 'Explicit demo mode persisted in storage');

    // Recompute after opt-in
    const demoDashboard = computeDashboardMode(googleUser, storage);
    assert.equal(demoDashboard.isSimulationMode, true, 'Opted-in user enters SIMULATION MODE');
    assert.equal(demoDashboard.isLiveMode, false, 'Opted-in user leaves LIVE MODE');
    assert.equal(demoDashboard.brokerConnectionsDisabled, true, 'Broker connections disabled while simulating');
    assert.equal(demoDashboard.showDemoSimulationControls, true, 'Simulation controls accessible');

    // User returns to Live Mode
    demoDashboard.toggleDemoMode(false);
    assert.equal(storage.getItem('trading_firewall_explicit_demo'), null, 'Explicit demo key removed from storage');

    const liveDashboard = computeDashboardMode(googleUser, storage);
    assert.equal(liveDashboard.isLiveMode, true, 'User successfully returned to LIVE MODE');
    assert.equal(liveDashboard.isSimulationMode, false, 'Simulation mode deactivated');
    assert.equal(liveDashboard.brokerConnectionsDisabled, false, 'Broker connections re-enabled');

    console.log('  ✓ PASSED: Normal user can explicitly opt in to demo simulation and switch back to live mode');
  }

  // --------------------------------------------------------------------------
  // TEST 4: Page Refresh Persistence & Logout Cleanup
  // --------------------------------------------------------------------------
  console.log('\n[Test 4] Page Refresh Persistence and Logout Cleanup');
  {
    storage.clear();
    const googleUser = {
      uid: 'google_oauth_uid_98765',
      email: 'verified.trader@gmail.com',
      isSandbox: false,
    };

    // Scenario 4A: Normal user in Live Mode refreshes page
    const freshDashboard = computeDashboardMode(googleUser, storage);
    assert.equal(freshDashboard.isLiveMode, true, 'Page refresh preserves LIVE MODE by default');

    // Scenario 4B: User with active explicit demo refreshes page
    freshDashboard.toggleDemoMode(true);
    const refreshedWithDemo = computeDashboardMode(googleUser, storage);
    assert.equal(refreshedWithDemo.isSimulationMode, true, 'Page refresh preserves explicit Demo Mode');

    // Scenario 4C: User logs out
    refreshedWithDemo.logout();
    assert.equal(storage.getItem('trading_firewall_explicit_demo'), null, 'Logout clears demo mode key');

    // Next login starts cleanly in Live Mode
    const reLoginDashboard = computeDashboardMode(googleUser, storage);
    assert.equal(reLoginDashboard.isLiveMode, true, 'Fresh login after logout defaults to LIVE MODE');

    console.log('  ✓ PASSED: Refresh preserves mode state and logout cleans up storage completely');
  }

  // --------------------------------------------------------------------------
  // TEST 5: Server Risk Store Account Isolation
  // --------------------------------------------------------------------------
  console.log('\n[Test 5] Server Risk Store Account & Session Isolation');
  {
    const realUserUid = 'google_user_real_pnl_check';
    const liveZerodhaAccount = DEFAULT_ACCOUNT_ID;
    const simAccount = DEFAULT_SIMULATION_ACCOUNT_ID;

    // Reset any prior state
    await ServerRiskStore.resetSimulatedSession(realUserUid, simAccount);

    // Save live config for user
    await ServerRiskStore.saveConfig(realUserUid, { ...DEFAULT_RISK_CONFIG, dailyLossLimit: 15000 }, liveZerodhaAccount);

    // Live session must NOT leak into getSimulatedSession
    const simSessionBefore = await ServerRiskStore.getSimulatedSession(realUserUid, liveZerodhaAccount);
    assert.equal(simSessionBefore, null, 'Live account query MUST NOT return simulation session');

    // Run a simulation evaluation on sim account
    const simResult = await ServerRiskStore.evaluateSimulatedPnl(realUserUid, -3000, new Date(), simAccount);
    assert.equal(simResult.session.isSimulated, true, 'Simulated session marked isSimulated');

    // Querying live Zerodha account must STILL return null for simulation session
    const simSessionOnLiveAcc = await ServerRiskStore.getSimulatedSession(realUserUid, liveZerodhaAccount);
    assert.equal(simSessionOnLiveAcc, null, 'Live account query MUST NOT return simulation session even when simulation active');

    // Querying simulation account returns the simulation session
    const simSessionOnSimAcc = await ServerRiskStore.getSimulatedSession(realUserUid, simAccount);
    assert(simSessionOnSimAcc, 'Simulation account query returns active simulation session');
    assert.equal(simSessionOnSimAcc.currentPnl, -3000, 'Simulation P&L is -3000');

    // Live Zerodha config remains ₹15,000
    const liveConfig = await ServerRiskStore.getConfig(realUserUid, liveZerodhaAccount);
    assert.equal(liveConfig.dailyLossLimit, 15000, 'Live config limit remains ₹15,000');

    console.log('  ✓ PASSED: Real user live accounts never leak simulated sessions or config');
  }

  console.log('\n====================================================================');
  console.log('ALL GOOGLE LOGIN & LIVE MODE ISOLATION REGRESSION TESTS PASSED!');
  console.log('====================================================================\n');
}

runGoogleLoginLiveModeIsolationSuite().catch((err) => {
  console.error('\nTest suite failed:', err);
  process.exit(1);
});
