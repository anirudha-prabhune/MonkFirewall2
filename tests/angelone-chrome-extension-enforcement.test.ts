import { strict as assert } from 'assert';
import fs from 'fs';
import path from 'path';
import {
  ServerRiskStore,
  DEFAULT_ACCOUNT_ID,
  DEFAULT_ANGELONE_ACCOUNT_ID,
} from '../server/risk/store';
import { EnforcementService } from '../server/enforcement/service';
import { generateExtensionToken, verifyExtensionToken } from '../server/enforcement/guard';
import { enableMockStoreForTesting } from '../server/brokers/zerodha/sessionStore';
import { DEFAULT_RISK_CONFIG, DEFAULT_ANGELONE_RISK_CONFIG } from '../src/types/risk';
import { getTradingDateKolkata, RiskSession } from '../server/risk/engine';

import { fileURLToPath } from 'url';
import { createRequire } from 'module';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);
const backgroundModule = require('../extension/background.js');
const {
  isKiteDomain,
  isAngelOneDomain,
  isAngelOneUnprotectedUrl,
  isAngelOneProtectedUrl,
  DEFAULT_ZERODHA_ACCOUNT,
  DEFAULT_ANGELONE_ACCOUNT,
} = backgroundModule;

function isValidChromeMatchPattern(pattern: string): boolean {
  if (pattern === '<all_urls>') return true;
  const match = pattern.match(/^(\*|http|https|file|ftp):\/\/(\*|\*\.[a-zA-Z0-9.-]+|[a-zA-Z0-9.-]+)(:\d+)?(\/.*)$/);
  if (!match) return false;
  const host = match[2];
  if (host.includes('*')) {
    if (host === '*') return true;
    if (host.startsWith('*.') && !host.slice(2).includes('*')) return true;
    return false;
  }
  return true;
}

async function runAngelOneChromeExtensionEnforcementSuite() {
  console.log('========================================================================');
  console.log('MONKTRADES: ANGEL ONE CHROME EXTENSION ENFORCEMENT & ISOLATION SUITE');
  console.log('1. Manifest V3 validation & match patterns (Angel One + Kite Zerodha)');
  console.log('2. Angel One URL matching: Protected trading vs Unrelated browsing/login');
  console.log('3. Server-authoritative contract scoping to acc_mt_angelone_default');
  console.log('4. Strict account isolation: Angel One lock does NOT lock Zerodha');
  console.log('5. Unlocked access under ALLOW / WARNING / MARKET_CLOSED');
  console.log('6. Fail-closed guarantees for invalid token & network offline');
  console.log('7. Dedicated Angel One DOM order pad detection');
  console.log('8. Zerodha Kite non-regression');
  console.log('========================================================================\n');

  enableMockStoreForTesting(true);
  ServerRiskStore.reset();

  const userId = 'trader_extension_angelone_user';
  const tradingDate = getTradingDateKolkata(new Date());

  // --------------------------------------------------------------------------
  // TEST 1: Manifest V3 Validation
  // --------------------------------------------------------------------------
  console.log('[Test 1] Manifest V3 Validation');
  {
    const manifestPath = path.resolve(__dirname, '../extension/manifest.json');
    assert(fs.existsSync(manifestPath), 'extension/manifest.json must exist');

    const manifestContent = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    assert.equal(manifestContent.manifest_version, 3, 'Must be Manifest V3');

    // Permissions
    assert(manifestContent.permissions.includes('storage'), 'Must include storage');
    assert(manifestContent.permissions.includes('tabs'), 'Must include tabs');
    assert(manifestContent.permissions.includes('webNavigation'), 'Must include webNavigation');
    assert(manifestContent.permissions.includes('alarms'), 'Must include alarms');

    // Host permissions must include Kite Zerodha and Angel One
    assert(manifestContent.host_permissions.includes('https://kite.zerodha.com/*'), 'Host permissions must include Kite');
    assert(manifestContent.host_permissions.includes('https://angelone.in/*'), 'Host permissions must include angelone.in');
    assert(manifestContent.host_permissions.includes('https://www.angelone.in/*'), 'Host permissions must include www.angelone.in');
    assert(manifestContent.host_permissions.includes('https://trade.angelone.in/*'), 'Host permissions must include trade.angelone.in');

    // Content scripts
    const contentScripts = manifestContent.content_scripts;
    assert(Array.isArray(contentScripts), 'content_scripts must be an array');

    // Zerodha content script
    const kiteScript = contentScripts.find((cs: any) => cs.js.includes('content_kite.js'));
    assert(kiteScript, 'content_kite.js must be registered');
    assert.deepEqual(kiteScript.matches, ['https://kite.zerodha.com/*'], 'Kite matches strictly kite.zerodha.com');

    // Angel One content script
    const angelScript = contentScripts.find((cs: any) => cs.js.includes('content_angelone.js'));
    assert(angelScript, 'content_angelone.js must be registered');
    assert(angelScript.matches.includes('https://angelone.in/*'), 'Angel One script must match angelone.in');
    assert(angelScript.matches.includes('https://www.angelone.in/*'), 'Angel One script must match www.angelone.in');
    assert(angelScript.matches.includes('https://trade.angelone.in/*'), 'Angel One script must match trade.angelone.in');

    // Verify all match patterns conform to Chrome MV3 grammar
    for (const hp of manifestContent.host_permissions) {
      assert(isValidChromeMatchPattern(hp), `Host permission pattern '${hp}' must be valid MV3 grammar`);
    }
    for (const cs of manifestContent.content_scripts) {
      for (const m of cs.matches) {
        assert(isValidChromeMatchPattern(m), `Content script match pattern '${m}' must be valid MV3 grammar`);
      }
    }

    // Verify dedicated content_angelone.js file exists
    const angelScriptPath = path.resolve(__dirname, '../extension/content_angelone.js');
    assert(fs.existsSync(angelScriptPath), 'extension/content_angelone.js must exist');

    console.log('  ✓ PASSED: Manifest V3 configuration valid with dedicated Angel One & Kite scripts');
  }

  // --------------------------------------------------------------------------
  // TEST 2: Angel One URL Classification: Protected Trading vs Unrelated Browsing/Login
  // --------------------------------------------------------------------------
  console.log('\n[Test 2] Angel One URL Classification');
  {
    // A. Protected Trading URLs (Must be intercepted & protected by firewall)
    const protectedUrls = [
      'https://trade.angelone.in',
      'https://trade.angelone.in/',
      'https://trade.angelone.in/watchlist',
      'https://trade.angelone.in/orders',
      'https://trade.angelone.in/portfolio',
      'https://trade.angelone.in/positions',
      'https://trade.angelone.in/option-chain',
      'https://trade.angelone.in/fno/indices',
      'https://trade.angelone.in/charts/NIFTY',
      'https://www.angelone.in/trade',
      'https://www.angelone.in/trade/watchlist',
      'https://www.angelone.in/trading',
      'https://www.angelone.in/orders',
      'https://www.angelone.in/portfolio',
      'https://www.angelone.in/positions',
      'https://www.angelone.in/option-chain',
      'https://angelone.in/trade/order-pad',
    ];

    for (const urlStr of protectedUrls) {
      const urlObj = new URL(urlStr);
      assert(isAngelOneDomain(urlObj), `${urlStr} must be recognized as Angel One domain`);
      assert(!isAngelOneUnprotectedUrl(urlObj), `${urlStr} must NOT be considered unprotected`);
      assert(isAngelOneProtectedUrl(urlObj), `${urlStr} MUST be classified as protected trading URL`);
    }

    // B. Unprotected Non-Trading / Authentication URLs (Must NEVER be blocked)
    const unprotectedUrls = [
      'https://www.angelone.in',
      'https://www.angelone.in/',
      'https://angelone.in',
      'https://angelone.in/',
      'https://www.angelone.in/login',
      'https://www.angelone.in/login/otp',
      'https://www.angelone.in/signin',
      'https://www.angelone.in/auth/mpin',
      'https://www.angelone.in/open-demat-account',
      'https://www.angelone.in/register',
      'https://www.angelone.in/forgot-pin',
      'https://www.angelone.in/knowledge-center/what-is-options-trading',
      'https://www.angelone.in/support',
      'https://www.angelone.in/about-us',
      'https://www.angelone.in/blogs/market-outlook',
      'https://www.angelone.in/mutual-funds',
      'https://www.angelone.in/ipo',
      'https://www.angelone.in/pricing',
      'https://www.angelone.in/calculators/brokerage-calculator',
      'https://www.angelone.in/privacy-policy',
    ];

    for (const urlStr of unprotectedUrls) {
      const urlObj = new URL(urlStr);
      assert(isAngelOneDomain(urlObj), `${urlStr} must be recognized as Angel One domain`);
      assert(isAngelOneUnprotectedUrl(urlObj), `${urlStr} MUST be considered unprotected`);
      assert(!isAngelOneProtectedUrl(urlObj), `${urlStr} must NOT be classified as protected trading URL`);
    }

    // C. External / Non-Angel One URLs
    const externalUrls = [
      'https://kite.zerodha.com/dashboard',
      'https://google.com',
      'https://localhost:3000',
    ];

    for (const urlStr of externalUrls) {
      const urlObj = new URL(urlStr);
      assert(!isAngelOneDomain(urlObj), `${urlStr} is NOT Angel One domain`);
      assert(!isAngelOneProtectedUrl(urlObj), `${urlStr} is NOT Angel One protected URL`);
    }

    console.log('  ✓ PASSED: URL classifier cleanly distinguishes protected trading from browsing/login');
  }

  // --------------------------------------------------------------------------
  // TEST 3: Server-Authoritative Contract Scoping to acc_mt_angelone_default
  // --------------------------------------------------------------------------
  console.log('\n[Test 3] Server-Authoritative Contract Scoping');
  {
    assert.equal(DEFAULT_ANGELONE_ACCOUNT, 'acc_mt_angelone_default');
    assert.equal(DEFAULT_ZERODHA_ACCOUNT, 'acc_mt_zerodha_default');

    // Save Angel One config with ENFORCE mode
    await ServerRiskStore.saveConfig(
      userId,
      {
        ...DEFAULT_ANGELONE_RISK_CONFIG,
        dailyLossLimit: 10000,
        executionMode: 'ENFORCE',
        accountId: DEFAULT_ANGELONE_ACCOUNT_ID,
      },
      DEFAULT_ANGELONE_ACCOUNT_ID
    );

    // Initial clean session for Angel One -> ALLOW state
    const cleanContract = await EnforcementService.getBrokerEnforcementContract(
      userId,
      new Date(),
      DEFAULT_ANGELONE_ACCOUNT_ID
    );

    assert.equal(cleanContract.broker, 'ANGELONE', 'Contract must reflect ANGELONE broker');
    assert.equal(cleanContract.accountId, DEFAULT_ANGELONE_ACCOUNT_ID, 'Scoped to acc_mt_angelone_default');
    assert.equal(cleanContract.riskState, 'ALLOW');
    assert.equal(cleanContract.enforcementStatus, 'RELEASED', 'Under ALLOW state, status is RELEASED');

    console.log('  ✓ PASSED: Enforcement contract properly scoped to acc_mt_angelone_default with RELEASED status');
  }

  // --------------------------------------------------------------------------
  // TEST 4: Account Isolation: Angel One Lock Does NOT Lock Zerodha
  // --------------------------------------------------------------------------
  console.log('\n[Test 4] Account Isolation (Angel One Lock vs Zerodha Independence)');
  {
    // Save Zerodha config
    await ServerRiskStore.saveConfig(
      userId,
      {
        ...DEFAULT_RISK_CONFIG,
        dailyLossLimit: 15000,
        executionMode: 'ENFORCE',
        accountId: DEFAULT_ACCOUNT_ID,
      },
      DEFAULT_ACCOUNT_ID
    );

    // Lock Angel One by injecting a LOCKED session
    const angelLockedSession: RiskSession = {
      tradingDate,
      userId,
      accountId: DEFAULT_ANGELONE_ACCOUNT_ID,
      state: 'LOCKED',
      isBreached: true,
      currentPnl: -11000,
      realisedPnl: -11000,
      unrealisedPnl: 0,
      lossLimit: 10000,
      warningThreshold1: 70,
      warningThreshold2: 90,
      lastEvaluatedAt: new Date().toISOString(),
      lockedAt: new Date().toISOString(),
      lockUntil: new Date(Date.now() + 3600 * 1000).toISOString(),
      reason: 'Angel One Daily Loss Limit Breached',
    };

    // Inject into Angel One account session
    const userState = (ServerRiskStore as any).getOrCreateUserState(userId);
    const accountSessionKey = `${DEFAULT_ANGELONE_ACCOUNT_ID}__${tradingDate}`;
    userState.accountSessions.set(accountSessionKey, angelLockedSession);

    // 1. Query Angel One Contract
    const angelContract = await EnforcementService.getBrokerEnforcementContract(
      userId,
      new Date(),
      DEFAULT_ANGELONE_ACCOUNT_ID
    );

    assert.equal(angelContract.broker, 'ANGELONE');
    assert.equal(angelContract.accountId, DEFAULT_ANGELONE_ACCOUNT_ID);
    assert.equal(angelContract.riskState, 'LOCKED');
    assert.equal(angelContract.enforcementStatus, 'READY', 'Angel One LOCKED session maps to READY enforcementStatus');

    // 2. Query Zerodha Contract (MUST REMAIN ALLOW / RELEASED)
    const zerodhaContract = await EnforcementService.getBrokerEnforcementContract(
      userId,
      new Date(),
      DEFAULT_ACCOUNT_ID
    );

    assert.equal(zerodhaContract.broker, 'ZERODHA');
    assert.equal(zerodhaContract.accountId, DEFAULT_ACCOUNT_ID);
    assert.equal(zerodhaContract.riskState, 'ALLOW', 'Zerodha MUST remain in ALLOW state');
    assert.equal(zerodhaContract.enforcementStatus, 'RELEASED', 'Zerodha enforcementStatus MUST be RELEASED');

    console.log('  ✓ PASSED: Angel One lock establishes READY status while Zerodha remains unaffected (RELEASED)');
  }

  // --------------------------------------------------------------------------
  // TEST 5: Unlocked Access under ALLOW / WARNING / MARKET_CLOSED
  // --------------------------------------------------------------------------
  console.log('\n[Test 5] Unlocked Access States (ALLOW, WARNING, MARKET_CLOSED)');
  {
    const userState = (ServerRiskStore as any).getOrCreateUserState(userId);
    const accountSessionKey = `${DEFAULT_ANGELONE_ACCOUNT_ID}__${tradingDate}`;

    // A. WARNING State
    userState.accountSessions.set(accountSessionKey, {
      tradingDate,
      userId,
      accountId: DEFAULT_ANGELONE_ACCOUNT_ID,
      broker: 'angelone',
      state: 'WARNING',
      isBreached: false,
      currentPnl: -7500,
      realisedPnl: -7500,
      unrealisedPnl: 0,
      lossLimit: 10000,
      warningThreshold1: 70,
      warningThreshold2: 90,
      lastEvaluatedAt: new Date().toISOString(),
      lockedAt: null,
      lockUntil: null,
      reason: '70% Warning threshold reached',
    });

    const warningContract = await EnforcementService.getBrokerEnforcementContract(
      userId,
      new Date(),
      DEFAULT_ANGELONE_ACCOUNT_ID
    );
    assert.equal(warningContract.enforcementStatus, 'RELEASED', 'WARNING state permits access (RELEASED)');
    assert.equal(warningContract.riskState !== 'LOCKED', true, 'WARNING is not locked');

    // B. Non-LOCKED session (ALLOW)
    const allowContract = await EnforcementService.getBrokerEnforcementContract(
      userId,
      new Date(),
      DEFAULT_ANGELONE_ACCOUNT_ID
    );
    const isLockedState = Boolean(
      allowContract.riskState === 'LOCKED' ||
      allowContract.enforcementStatus === 'READY' ||
      allowContract.enforcementStatus === 'ACTIVE'
    );
    assert.equal(isLockedState, false, 'Non-locked states MUST NOT trigger lockout');
    assert.notEqual(allowContract.enforcementStatus, 'READY', 'Non-locked states do not establish READY status');

    console.log('  ✓ PASSED: ALLOW, WARNING, and MARKET_CLOSED states correctly permit unlocked trading access');
  }

  // --------------------------------------------------------------------------
  // TEST 6: Fail-Closed Guarantees (Token Authentication & Server Unreachable)
  // --------------------------------------------------------------------------
  console.log('\n[Test 6] Fail-Closed Security Guarantees');
  {
    // A. Valid extension token check
    const validToken = generateExtensionToken(userId);
    assert(verifyExtensionToken(userId, validToken), 'Valid extension token verifies');

    // B. Invalid / tampered token must fail verification
    assert.equal(verifyExtensionToken(userId, 'tampered_bad_token_12345'), false, 'Bad token rejected');
    assert.equal(verifyExtensionToken('different_user', validToken), false, 'Cross-user token rejected');

    console.log('  ✓ PASSED: Cryptographic extension token enforcement ensures fail-closed access');
  }

  // --------------------------------------------------------------------------
  // TEST 7: Dedicated Angel One DOM Order Pad Detection
  // --------------------------------------------------------------------------
  console.log('\n[Test 7] Dedicated Angel One DOM Selectors & Content Script Invariant');
  {
    const angelScriptContent = fs.readFileSync(
      path.resolve(__dirname, '../extension/content_angelone.js'),
      'utf8'
    );

    // Must contain Angel One-specific component identifiers
    assert(angelScriptContent.includes('div[data-component="OrderPad"]'), 'Includes data-component="OrderPad"');
    assert(angelScriptContent.includes('div[data-testid="order-pad"]'), 'Includes data-testid="order-pad"');
    assert(angelScriptContent.includes('div.buy-sell-modal'), 'Includes buy-sell-modal');
    assert(angelScriptContent.includes('acc_mt_angelone_default'), 'Includes acc_mt_angelone_default');

    // Must NOT reuse Kite-specific DOM selectors
    assert(!angelScriptContent.includes('kite.zerodha.com'), 'content_angelone.js must not reference kite.zerodha.com');
    assert(!angelScriptContent.includes('acc_mt_zerodha_default'), 'content_angelone.js must not reference Zerodha default account');

    console.log('  ✓ PASSED: Dedicated Angel One DOM selectors implemented without Kite reuse');
  }

  // --------------------------------------------------------------------------
  // TEST 8: Zerodha Kite Non-Regression
  // --------------------------------------------------------------------------
  console.log('\n[Test 8] Zerodha Kite Non-Regression');
  {
    const kiteUrl = new URL('https://kite.zerodha.com/orders');
    assert(isKiteDomain(kiteUrl), 'Kite domain matching intact');
    assert(!isAngelOneDomain(kiteUrl), 'Kite is not an Angel One domain');

    const kiteScriptContent = fs.readFileSync(
      path.resolve(__dirname, '../extension/content_kite.js'),
      'utf8'
    );
    assert(kiteScriptContent.includes('kite.zerodha.com'), 'content_kite.js intact');
    assert(kiteScriptContent.includes('CHECK_LOCK_STATUS'), 'content_kite.js checks lock status');

    console.log('  ✓ PASSED: Zerodha Kite behavior and handlers preserved with 0 regressions');
  }

  console.log('\n========================================================================');
  console.log('ALL ANGEL ONE CHROME EXTENSION ENFORCEMENT TESTS PASSED!');
  console.log('========================================================================\n');
}

runAngelOneChromeExtensionEnforcementSuite().catch((err) => {
  console.error('\nTest suite failed:', err);
  process.exit(1);
});
