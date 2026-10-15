import { strict as assert } from 'assert';
import { liveZerodhaAdapter } from '../server/brokers/zerodha/liveAdapter';
import { liveAngelOneAdapter } from '../server/brokers/angelone/liveAdapter';
import { ZerodhaSessionStore, enableMockStoreForTesting as enableZerodhaMockStore } from '../server/brokers/zerodha/sessionStore';
import { AngelOneSessionStore } from '../server/brokers/angelone/sessionStore';
import { ZerodhaCredentialManager } from '../server/brokers/zerodha/credentials';

/**
 * Helper that awaits an actual AbortSignal abort event while keeping the Node.js event
 * loop active (since AbortSignal.timeout() utilizes unref'd timers in Node runtime).
 */
function waitForSignalAbort(signal: AbortSignal, maxWaitMs = 1500): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) {
      const err = new Error('The operation was aborted due to timeout');
      err.name = 'TimeoutError';
      return reject(err);
    }
    const timer = setTimeout(() => {
      reject(new Error('Test timeout waiting for AbortSignal to abort'));
    }, maxWaitMs);

    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        const err = new Error('The operation was aborted due to timeout');
        err.name = 'TimeoutError';
        reject(err);
      },
      { once: true }
    );
  });
}

async function runPhase6bRemediationTestSuite() {
  console.log('================================================================');
  console.log('MonkTrades Phase 6B/6C.1: Upstream Timeout & Fail-Closed Test Suite');
  console.log('================================================================\n');

  enableZerodhaMockStore(true);
  AngelOneSessionStore.enableMockStoreForTesting(true);

  // Set test credentials
  process.env.ZERODHA_API_KEY = 'test_api_key_p6b';
  process.env.ZERODHA_API_SECRET = 'test_api_secret_p6b';

  // --------------------------------------------------------------------------
  // TEST 1: Zerodha Live Capital Upstream Timeout & Real AbortSignal Propagation
  // --------------------------------------------------------------------------
  console.log('[Test 1] Zerodha Live Capital Upstream Timeout & Real AbortSignal Propagation');
  {
    const userId = 'user_zerodha_timeout';
    await ZerodhaSessionStore.saveSession(userId, 'valid_access_token_zerodha_p6b');

    liveZerodhaAdapter.setTimeoutMs(50);
    let signalReceived: AbortSignal | undefined;

    liveZerodhaAdapter.setFetchHandler(async (_url: string, options: any) => {
      signalReceived = options.signal;
      assert.ok(signalReceived instanceof AbortSignal, 'fetch must receive an AbortSignal in options');
      return waitForSignalAbort(signalReceived!);
    });

    const capital = await liveZerodhaAdapter.getCapital(userId);

    assert.ok(signalReceived, 'Signal was passed to fetch handler');
    assert.equal(signalReceived.aborted, true, 'Signal must be aborted upon timeout expiry');
    assert.equal(capital.broker, 'zerodha');
    assert.equal(capital.dataSource, 'ZERODHA_LIVE');
    assert.ok(capital.connectionStatus === 'UPSTREAM_ERROR' || capital.connectionStatus === 'ERROR', 'connectionStatus must indicate error');
    assert.equal(capital.netBalance, null, 'netBalance must be null on timeout');
    assert.equal(capital.availableCash, null, 'availableCash must be null on timeout');
    assert.equal(capital.availableTradingMargin, null, 'availableTradingMargin must be null on timeout');
    assert.equal(capital.utilizedMargin, null, 'utilizedMargin must be null on timeout');
    assert.equal(capital.withdrawableFunds, null, 'withdrawableFunds must be null on timeout');
    assert.equal(capital.isStale, true, 'isStale must be true on timeout');
    assert.notEqual(capital.dataSource, 'MOCK_DATA', 'Must NOT substitute MOCK_DATA');
    assert.ok(capital.semanticNote.includes('timeout') || capital.semanticNote.includes('aborted'), 'Semantic note captures timeout');
    console.log('  ✓ PASSED: Zerodha upstream timeout propagates real AbortSignal and fails closed with null capital and isStale=true');
  }

  // --------------------------------------------------------------------------
  // TEST 2: Caller-Supplied Signal Cannot Bypass Zerodha Hard Timeout
  // --------------------------------------------------------------------------
  console.log('\n[Test 2] Caller-Supplied Signal Cannot Bypass Zerodha Hard Timeout');
  {
    const userId = 'user_zerodha_caller_signal';
    await ZerodhaSessionStore.saveSession(userId, 'valid_access_token_zerodha_p6b');

    liveZerodhaAdapter.setTimeoutMs(50);
    const callerController = new AbortController();
    let effectiveSignalReceived: AbortSignal | undefined;

    liveZerodhaAdapter.setFetchHandler(async (_url: string, options: any) => {
      effectiveSignalReceived = options.signal;
      assert.ok(effectiveSignalReceived instanceof AbortSignal, 'effectiveSignal must be an AbortSignal');
      return waitForSignalAbort(effectiveSignalReceived!);
    });

    const capital = await liveZerodhaAdapter.getCapital(userId);

    assert.equal(callerController.signal.aborted, false, 'Caller signal was not aborted');
    assert.equal(effectiveSignalReceived!.aborted, true, 'Effective signal was aborted by the hard timeout');
    assert.equal(capital.netBalance, null, 'Capital fails closed');
    assert.equal(capital.isStale, true, 'isStale is true');
    console.log('  ✓ PASSED: Non-aborting caller signal does NOT bypass hard timeout via AbortSignal.any');
  }

  // --------------------------------------------------------------------------
  // TEST 3: Angel One Live Capital Upstream Timeout & Real AbortSignal Propagation
  // --------------------------------------------------------------------------
  console.log('\n[Test 3] Angel One Live Capital Upstream Timeout & Real AbortSignal Propagation');
  {
    const userId = 'user_angelone_timeout';
    await AngelOneSessionStore.saveSession(userId, 'valid_access_token_angelone_p6b_longer');
    await AngelOneSessionStore.saveApiKey(userId, 'ANGEL_TIMEOUT_KEY_123');

    liveAngelOneAdapter.setTimeoutMs(50);
    let signalReceived: AbortSignal | undefined;

    liveAngelOneAdapter.setFetchHandler((async (_url: any, options: any) => {
      signalReceived = options.signal;
      assert.ok(signalReceived instanceof AbortSignal, 'fetch must receive an AbortSignal in options');
      return waitForSignalAbort(signalReceived!);
    }) as any);

    const capital = await liveAngelOneAdapter.getCapital(userId);

    assert.ok(signalReceived, 'Signal was passed to fetch handler');
    assert.equal(signalReceived.aborted, true, 'Signal must be aborted upon timeout expiry');
    assert.equal(capital.broker, 'angelone');
    assert.equal(capital.dataSource, 'ANGELONE_LIVE');
    assert.equal(capital.connectionStatus, 'ERROR');
    assert.equal(capital.netBalance, null, 'netBalance must be null on timeout');
    assert.equal(capital.availableCash, null, 'availableCash must be null on timeout');
    assert.equal(capital.availableTradingMargin, null, 'availableTradingMargin must be null on timeout');
    assert.equal(capital.utilizedMargin, null, 'utilizedMargin must be null on timeout');
    assert.equal(capital.withdrawableFunds, null, 'withdrawableFunds must be null on timeout');
    assert.equal(capital.isStale, true, 'isStale must be true on timeout');
    assert.notEqual(capital.dataSource, 'MOCK_DATA', 'Must NOT substitute MOCK_DATA');
    assert.ok(capital.semanticNote.includes('timeout') || capital.semanticNote.includes('aborted'), 'Semantic note captures timeout');
    console.log('  ✓ PASSED: Angel One upstream timeout propagates real AbortSignal and fails closed with null capital and isStale=true');
  }

  // --------------------------------------------------------------------------
  // TEST 4: Angel One Positions Upstream Timeout Error Handling
  // --------------------------------------------------------------------------
  console.log('\n[Test 4] Angel One Positions Upstream Timeout Error Handling');
  {
    const userId = 'user_angelone_timeout';
    liveAngelOneAdapter.setTimeoutMs(50);
    let errorCaught = false;

    try {
      await liveAngelOneAdapter.getPositions(userId);
    } catch (err: any) {
      errorCaught = true;
      assert.ok(err.message.includes('aborted') || err.message.includes('timeout'), 'Error message preserves timeout indication');
    }

    assert.equal(errorCaught, true, 'getPositions throws error on upstream timeout');
    console.log('  ✓ PASSED: Angel One positions request fails closed on upstream timeout');
  }

  // --------------------------------------------------------------------------
  // TEST 5: Zerodha Token Exchange (/session/token) Timeout & Real AbortSignal Enforcement
  // --------------------------------------------------------------------------
  console.log('\n[Test 5] Zerodha Token Exchange (/session/token) Timeout & Real AbortSignal Enforcement');
  {
    let signalReceived: AbortSignal | undefined;

    const mockFetch = (async (_url: any, options: any) => {
      signalReceived = options.signal;
      assert.ok(signalReceived instanceof AbortSignal, 'fetch must receive an AbortSignal in options');
      return waitForSignalAbort(signalReceived!);
    }) as any;

    const result = await ZerodhaCredentialManager.exchangeRequestToken(
      'mock_req_token_p6c',
      'user_token_timeout',
      {
        customFetch: mockFetch,
        timeoutMs: 50,
      }
    );

    assert.ok(signalReceived, 'Signal was passed to token exchange fetch');
    assert.equal(signalReceived.aborted, true, 'Signal was aborted by the 50ms timeout');
    assert.equal(result.success, false, 'Token exchange must fail when timed out');
    assert.ok(result.error?.includes('timed out') || result.error?.includes('aborted'), 'Error indicates timeout or abort');
    assert.equal(result.session, undefined, 'No session returned on timeout');
    console.log('  ✓ PASSED: Zerodha /session/token upstream timeout fails closed and sanitizes error');
  }

  // --------------------------------------------------------------------------
  // TEST 6: Zerodha Token Exchange with Non-Aborting Caller Signal (AbortSignal.any)
  // --------------------------------------------------------------------------
  console.log('\n[Test 6] Zerodha Token Exchange Caller Signal Does Not Bypass Timeout');
  {
    const callerController = new AbortController();
    let effectiveSignalReceived: AbortSignal | undefined;

    const mockFetch = (async (_url: any, options: any) => {
      effectiveSignalReceived = options.signal;
      assert.ok(effectiveSignalReceived instanceof AbortSignal, 'fetch must receive an AbortSignal in options');
      return waitForSignalAbort(effectiveSignalReceived!);
    }) as any;

    const result = await ZerodhaCredentialManager.exchangeRequestToken(
      'mock_req_token_p6c_2',
      'user_token_timeout_2',
      {
        customFetch: mockFetch,
        signal: callerController.signal,
        timeoutMs: 50,
      }
    );

    assert.equal(callerController.signal.aborted, false, 'Caller signal was not aborted');
    assert.equal(effectiveSignalReceived!.aborted, true, 'Effective signal was aborted by timeout');
    assert.equal(result.success, false, 'Token exchange failed');
    console.log('  ✓ PASSED: Caller signal cannot bypass token exchange hard timeout');
  }

  // Reset production timeout defaults
  liveZerodhaAdapter.setTimeoutMs(8000);
  liveAngelOneAdapter.setTimeoutMs(8000);
  liveZerodhaAdapter.setFetchHandler(undefined);
  liveAngelOneAdapter.setFetchHandler(undefined);

  console.log('\n================================================================');
  console.log('ALL PHASE 6B/6C.1 TIMEOUT & FAIL-CLOSED TESTS PASSED (6/6)');
  console.log('================================================================\n');
}

runPhase6bRemediationTestSuite().catch((err) => {
  console.error('Phase 6B/6C.1 Remediation Test Suite Failed:', err);
  process.exit(1);
});
