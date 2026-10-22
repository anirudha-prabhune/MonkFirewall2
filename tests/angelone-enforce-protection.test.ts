import { strict as assert } from 'assert';
import { ServerRiskStore, DEFAULT_ACCOUNT_ID, DEFAULT_ANGELONE_ACCOUNT_ID } from '../server/risk/store';
import { PnlEngine } from '../server/pnl/engine';
import { RiskEngine } from '../server/risk/engine';
import { EnforcementService } from '../server/enforcement/service';
import { enableMockStoreForTesting, setAdminFirestoreForTesting } from '../server/brokers/zerodha/sessionStore';
import { DEFAULT_RISK_CONFIG, DEFAULT_ANGELONE_RISK_CONFIG } from '../src/types/risk';
import { NormalizedPosition } from '../server/brokers/types';
import { liveAngelOneAdapter } from '../server/brokers/angelone/liveAdapter';

async function runAngelOneEnforceProtectionTests() {
  console.log('================================================================');
  console.log('Angel One Protection: ENFORCE Verification Test Suite');
  console.log('Account-Scoped Enforcement, Lock Lifecycle & Zerodha Isolation');
  console.log('================================================================\n');

  enableMockStoreForTesting(true);
  setAdminFirestoreForTesting(null);
  ServerRiskStore.reset();

  const userId = 'trader_enforce_test_user';

  // --------------------------------------------------------------------------
  // Scenario 1: Authoritative Configuration Verification (ENFORCE Mode)
  // --------------------------------------------------------------------------
  console.log('[Scenario 1] Authoritative Configuration Verification (ENFORCE Mode)...');
  {
    assert.equal(DEFAULT_ANGELONE_RISK_CONFIG.executionMode, 'ENFORCE', 'DEFAULT_ANGELONE_RISK_CONFIG must have executionMode: ENFORCE');
    assert.equal(DEFAULT_ANGELONE_RISK_CONFIG.broker, 'angelone');
    assert.equal(DEFAULT_ANGELONE_RISK_CONFIG.dailyLossLimit, 10000);

    const angelConfig = await ServerRiskStore.getConfig(userId, DEFAULT_ANGELONE_ACCOUNT_ID);
    assert.equal(angelConfig.executionMode, 'ENFORCE', 'Angel One account defaults to ENFORCE');
    assert.equal(angelConfig.dailyLossLimit, 10000, 'Angel One daily loss limit defaults to ₹10,000');
    assert.equal(angelConfig.broker, 'angelone');

    // Zerodha remains completely independent
    const zerodhaConfig = await ServerRiskStore.getConfig(userId, DEFAULT_ACCOUNT_ID);
    assert.equal(zerodhaConfig.executionMode, 'ENFORCE');
    assert.equal(zerodhaConfig.dailyLossLimit, DEFAULT_RISK_CONFIG.dailyLossLimit, 'Zerodha daily loss limit matches DEFAULT_RISK_CONFIG');
    assert.equal(zerodhaConfig.broker, 'zerodha');

    console.log('  ✓ PASSED: Angel One operates in ENFORCE mode with isolated account configuration.');
  }

  // --------------------------------------------------------------------------
  // Scenario 2: Warning Thresholds (70% and 90%) in ENFORCE Mode
  // --------------------------------------------------------------------------
  console.log('\n[Scenario 2] Warning Thresholds Progression in ENFORCE Mode...');
  {
    const angelConfig = await ServerRiskStore.getConfig(userId, DEFAULT_ANGELONE_ACCOUNT_ID);

    // 1. Loss at 50% (₹5,000) -> ALLOW state
    const pos50: NormalizedPosition[] = [
      {
        tradingsymbol: 'NIFTY26OCT25000CE',
        instrumentToken: 11111,
        exchange: 'NFO',
        product: 'NRML',
        segment: 'NFO-OPT',
        instrumentType: 'CE',
        quantity: 50,
        averagePrice: 200,
        lastPrice: 100,
        totalPnl: -5000,
        realisedPnl: 0,
        unrealisedPnl: -5000,
        dayBuyQuantity: 0,
        dayBuyValue: 0,
        daySellQuantity: 0,
        daySellValue: 0,
        isFno: true,
        dataSource: 'ANGELONE_LIVE',
      },
    ];
    const pnl50 = PnlEngine.calculate(pos50, angelConfig);
    const eval50 = await ServerRiskStore.evaluatePnlResult(userId, pnl50, new Date(), angelConfig, DEFAULT_ANGELONE_ACCOUNT_ID);
    assert.equal(eval50.session.state, 'ALLOW');
    assert.equal(eval50.session.isBreached, false);
    assert.equal(eval50.session.lockedAt, null);

    // 2. Loss at 75% (₹7,500 >= 70% T1) -> WARNING state
    const pos75: NormalizedPosition[] = [
      {
        ...pos50[0],
        lastPrice: 50,
        totalPnl: -7500,
        unrealisedPnl: -7500,
      },
    ];
    const pnl75 = PnlEngine.calculate(pos75, angelConfig);
    const eval75 = await ServerRiskStore.evaluatePnlResult(userId, pnl75, new Date(), angelConfig, DEFAULT_ANGELONE_ACCOUNT_ID);
    assert.equal(eval75.session.state, 'WARNING');
    assert.equal(eval75.session.isBreached, false);
    assert.equal(eval75.session.lockedAt, null);
    assert.ok(eval75.transitionEvents.some((e) => e.type === 'RISK_WARNING_70' || e.type === 'RISK_WARNING'));

    // 3. Loss at 92% (₹9,200 >= 90% T2) -> WARNING state
    const pos92: NormalizedPosition[] = [
      {
        ...pos50[0],
        lastPrice: 16,
        totalPnl: -9200,
        unrealisedPnl: -9200,
      },
    ];
    const pnl92 = PnlEngine.calculate(pos92, angelConfig);
    const eval92 = await ServerRiskStore.evaluatePnlResult(userId, pnl92, new Date(), angelConfig, DEFAULT_ANGELONE_ACCOUNT_ID);
    assert.equal(eval92.session.state, 'WARNING');
    assert.equal(eval92.session.isBreached, false);
    assert.equal(eval92.session.lockedAt, null);
    assert.ok(eval92.transitionEvents.some((e) => e.type === 'RISK_WARNING_90' || e.type === 'RISK_WARNING'));

    console.log('  ✓ PASSED: 70% and 90% warning thresholds transition state to WARNING without locking.');
  }

  // --------------------------------------------------------------------------
  // Scenario 3: Loss Limit Breach under ENFORCE Mode -> Circuit Breaker LOCKED
  // --------------------------------------------------------------------------
  console.log('\n[Scenario 3] Loss Limit Breach -> Account-Scoped LOCKED State...');
  {
    const angelConfig = await ServerRiskStore.getConfig(userId, DEFAULT_ANGELONE_ACCOUNT_ID);
    const breachedPositions: NormalizedPosition[] = [
      {
        tradingsymbol: 'BANKNIFTY26OCT50000CE',
        instrumentToken: 99999,
        exchange: 'NFO',
        product: 'NRML',
        segment: 'NFO-OPT',
        instrumentType: 'CE',
        quantity: 50,
        averagePrice: 300,
        lastPrice: 60,
        totalPnl: -12000,
        realisedPnl: 0,
        unrealisedPnl: -12000,
        dayBuyQuantity: 0,
        dayBuyValue: 0,
        daySellQuantity: 0,
        daySellValue: 0,
        isFno: true,
        dataSource: 'ANGELONE_LIVE',
      },
    ];

    const pnlBreach = PnlEngine.calculate(breachedPositions, angelConfig);
    assert.equal(pnlBreach.grossTradingPnl, -12000);

    const evalBreach = await ServerRiskStore.evaluatePnlResult(
      userId,
      pnlBreach,
      new Date(),
      angelConfig,
      DEFAULT_ANGELONE_ACCOUNT_ID
    );

    assert.equal(evalBreach.session.state, 'LOCKED', 'Under ENFORCE mode, breach establishes LOCKED state');
    assert.equal(evalBreach.session.isBreached, true);
    assert.ok(evalBreach.session.lockedAt !== null, 'lockedAt timestamp recorded');
    assert.ok(evalBreach.session.lockUntil !== null, 'lockUntil timestamp recorded');
    assert.ok(evalBreach.transitionEvents.some((e) => e.type === 'LOSS_LIMIT_BREACHED'));
    assert.ok(evalBreach.transitionEvents.some((e) => e.type === 'TRADING_LOCK_CREATED'));

    // Check Zerodha session: MUST remain ALLOW (no cross-broker lock leakage)
    const zerodhaSession = await ServerRiskStore.getSession(userId, undefined, DEFAULT_ACCOUNT_ID);
    assert.equal(zerodhaSession.state, 'ALLOW', 'Zerodha session MUST NOT be locked when Angel One breaches');

    console.log('  ✓ PASSED: Angel One breach establishes LOCKED circuit breaker; Zerodha remains ALLOW.');
  }

  // --------------------------------------------------------------------------
  // Scenario 4: Lock Immutability Guard While LOCKED
  // --------------------------------------------------------------------------
  console.log('\n[Scenario 4] Lock Immutability Guard While LOCKED...');
  {
    // Attempting to raise daily loss limit while LOCKED must fail
    const mutateRes = await ServerRiskStore.saveConfig(
      userId,
      {
        ...DEFAULT_ANGELONE_RISK_CONFIG,
        dailyLossLimit: 25000,
        executionMode: 'ENFORCE',
        accountId: DEFAULT_ANGELONE_ACCOUNT_ID,
      },
      DEFAULT_ANGELONE_ACCOUNT_ID
    );

    assert.equal(mutateRes.success, false, 'Mutating config during active lock must be rejected');
    assert.equal(mutateRes.code, 'RISK_CONFIG_LOCKED');

    const currentCfg = await ServerRiskStore.getConfig(userId, DEFAULT_ANGELONE_ACCOUNT_ID);
    assert.equal(currentCfg.dailyLossLimit, 10000, 'Daily loss limit preserved at ₹10,000');

    console.log('  ✓ PASSED: Daily loss limit cannot be raised while circuit breaker is LOCKED.');
  }

  // --------------------------------------------------------------------------
  // Scenario 5: Lock Persistence Across Disconnects & Re-Authentication
  // --------------------------------------------------------------------------
  console.log('\n[Scenario 5] Lock Persistence Across Disconnects & Re-Authentication...');
  {
    // Fetch session as if reconnecting or polling while disconnected
    const reconnectedSession = await ServerRiskStore.getSession(userId, undefined, DEFAULT_ANGELONE_ACCOUNT_ID);
    assert.equal(reconnectedSession.state, 'LOCKED', 'Active lock MUST persist across disconnections');
    assert.equal(reconnectedSession.isBreached, true);
    assert.ok(reconnectedSession.lockedAt !== null);
    assert.ok(reconnectedSession.lockUntil !== null);

    console.log('  ✓ PASSED: Reconnection and polling failures preserve active LOCKED circuit breaker.');
  }

  // --------------------------------------------------------------------------
  // Scenario 6: Account-Scoped Trading Enforcement Guard (HTTP 423 vs 200)
  // --------------------------------------------------------------------------
  console.log('\n[Scenario 6] EnforcementService Account-Scoped Trading Guard...');
  {
    // Angel One is LOCKED -> HTTP 423
    const angelDecision = await EnforcementService.checkTradingAccess(
      userId,
      new Date(),
      DEFAULT_ANGELONE_ACCOUNT_ID
    );
    assert.equal(angelDecision.allowed, false, 'Angel One protected trading access must be blocked');
    assert.equal(angelDecision.statusCode, 423, 'Angel One returns HTTP 423 LOCKED');
    assert.equal(angelDecision.error, 'TRADING_LOCKED');

    // Zerodha is NOT locked -> HTTP 200
    const zerodhaDecision = await EnforcementService.checkTradingAccess(
      userId,
      new Date(),
      DEFAULT_ACCOUNT_ID
    );
    assert.equal(zerodhaDecision.allowed, true, 'Zerodha protected trading access must be permitted');
    assert.equal(zerodhaDecision.statusCode, 200, 'Zerodha returns HTTP 200 OK');

    // Missing user credentials -> HTTP 401
    const unauthDecision = await EnforcementService.checkTradingAccess(
      undefined,
      new Date(),
      DEFAULT_ANGELONE_ACCOUNT_ID
    );
    assert.equal(unauthDecision.allowed, false);
    assert.equal(unauthDecision.statusCode, 401);
    assert.equal(unauthDecision.error, 'UNAUTHENTICATED');

    console.log('  ✓ PASSED: Trading guard blocks locked Angel One (HTTP 423) while allowing Zerodha (HTTP 200).');
  }

  // --------------------------------------------------------------------------
  // Scenario 7: Read-Only Invariant for Angel One
  // --------------------------------------------------------------------------
  console.log('\n[Scenario 7] Strictly Read-Only Invariant...');
  {
    const adapter = liveAngelOneAdapter as any;
    assert.equal(typeof adapter.placeOrder, 'undefined', 'Angel One adapter must NOT have placeOrder');
    assert.equal(typeof adapter.modifyOrder, 'undefined', 'Angel One adapter must NOT have modifyOrder');
    assert.equal(typeof adapter.cancelOrder, 'undefined', 'Angel One adapter must NOT have cancelOrder');
    assert.equal(typeof adapter.squareOff, 'undefined', 'Angel One adapter must NOT have squareOff');

    console.log('  ✓ PASSED: Angel One adapter is strictly read-only with zero order manipulation methods.');
  }

  console.log('\n================================================================');
  console.log('ALL ANGEL ONE ENFORCE PROTECTION TESTS PASSED (7/7)');
  console.log('================================================================\n');
}

runAngelOneEnforceProtectionTests().catch((err) => {
  console.error('\nEnforce Protection Test Suite Failed:', err);
  process.exit(1);
});
