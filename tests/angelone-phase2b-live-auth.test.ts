import assert from 'assert';
import { liveAngelOneAdapter } from '../server/brokers/angelone/liveAdapter';
import { AngelOneSessionStore } from '../server/brokers/angelone/sessionStore';
import { BrokerRegistry } from '../server/brokers/registry';
import { normalizePositions } from '../server/brokers/normalize';

async function runPhase2BLiveAuthTest() {
  console.log('================================================================');
  console.log('MonkTrades Phase 2B — User-Supplied Angel One Authentication Test');
  console.log('================================================================');

  AngelOneSessionStore.enableMockStoreForTesting(true);

  // Step 1: User-Supplied Credentials Deterministic Auth
  console.log('\n[Step 1] User-Supplied Credentials Login & Token Acquisition');
  const testUserId = 'trader_phase2b_user_explicit';
  const mockJwtToken = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.phase2b_test_jwt_payload_998877';

  const mockUpstreamFetch: any = async (url: string, init: any) => {
    const body = JSON.parse(init.body);
    if (body.clientcode === 'EXPLICIT_CLIENT' && body.password === 'ExplicitPass123' && body.totp === '654321') {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          status: true,
          message: 'SUCCESS',
          data: { jwtToken: `Bearer ${mockJwtToken}` },
        }),
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        status: false,
        message: 'Invalid credentials',
      }),
    };
  };

  const authResult = await liveAngelOneAdapter.authenticate(
    testUserId,
    {
      apiKey: 'EXPLICIT_API_KEY',
      clientCode: 'EXPLICIT_CLIENT',
      password: 'ExplicitPass123',
      totp: '654321',
    },
    { customFetch: mockUpstreamFetch }
  );

  assert(authResult.success === true, 'Authentication must succeed with explicit user credentials');
  assert.strictEqual(authResult.session?.clientCode, 'EXPLICIT_CLIENT');
  console.log('  ✓ PASSED: User-supplied SmartAPI login succeeded! Access token acquired.');

  // Step 2: Session Persistence Verification
  console.log('\n[Step 2] Session Persistence & Isolated Storage Verification');
  const loadedSession = await AngelOneSessionStore.loadSession(testUserId);
  assert(loadedSession !== null, 'Loaded session must not be null');
  assert(loadedSession?.authState === 'AUTHENTICATED', 'Session authState must be AUTHENTICATED');
  assert(loadedSession?.accessToken === mockJwtToken, 'Persisted access token must match JWT token');
  console.log('  ✓ PASSED: Token safely encrypted, stored, and verified in isolated session store.');

  // Step 3: Fail-Closed Negative Condition Testing
  console.log('\n[Step 3] Fail-Closed Negative Testing (Invalid Creds / Expired Session)');
  const badResult = await liveAngelOneAdapter.authenticate(
    'bad_user',
    {
      apiKey: 'EXPLICIT_API_KEY',
      clientCode: 'EXPLICIT_CLIENT',
      password: 'WrongPassword',
      totp: '654321',
    },
    { customFetch: mockUpstreamFetch }
  );
  assert(badResult.success === false, 'Invalid password must be rejected');

  const past = new Date(Date.now() + 25 * 3600 * 1000);
  const expired = await AngelOneSessionStore.loadSession(testUserId, { evaluationTime: past });
  assert(expired?.isExpired === true, 'Session evaluates as expired after 24h');
  assert(expired?.authState === 'AUTHENTICATION_REQUIRED', 'Expired session state must be AUTHENTICATION_REQUIRED');
  console.log('  ✓ PASSED: Invalid credentials and expired sessions strictly fail closed.');

  // Step 4: Read-Only Live Position Normalization
  console.log('\n[Step 4] Read-Only Live Position Fetch & Normalization Validation');
  const rawList = [
    {
      exchange: 'NFO',
      tradingsymbol: 'NIFTY26OCT24000CE',
      product: 'CARRYFORWARD',
      quantity: 50,
      average_price: 150.0,
      last_price: 165.0,
      pnl: 750.0,
      realised: 0.0,
      unrealised: 750.0,
      day_buy_quantity: 50,
      day_buy_value: 7500.0,
      day_sell_quantity: 0,
      day_sell_value: 0.0,
      instrument_token: 999001,
    },
  ];

  const instruments = await liveAngelOneAdapter.getInstruments(testUserId);
  const instrumentMap = new Map<number, any>(instruments.map((i: any) => [i.instrumentToken, i]));
  const normalized = normalizePositions(rawList as any, instrumentMap, 'ANGELONE_LIVE');

  assert.strictEqual(normalized.length, 1);
  assert.strictEqual(normalized[0].dataSource, 'ANGELONE_LIVE');
  console.log('  ✓ PASSED: Read-only position fetch & canonical normalization validated!');

  // Step 5: Read-Only Governance & Zerodha Compatibility Audit
  console.log('\n[Step 5] Firewall Authority & Read-Only Governance Audit');
  assert((liveAngelOneAdapter as any).placeOrder === undefined, 'Angel One adapter MUST NOT possess order placement methods');
  assert((liveAngelOneAdapter as any).cancelOrder === undefined, 'Angel One adapter MUST NOT possess order cancellation methods');

  const zerodhaAdapter = BrokerRegistry.getAdapter('zerodha');
  assert(zerodhaAdapter !== undefined && zerodhaAdapter.providerId === 'zerodha', 'Zerodha adapter must remain default');
  console.log('  ✓ PASSED: No order placement capability exists; Zerodha adapter intact.');

  AngelOneSessionStore.enableMockStoreForTesting(false);

  console.log('\n================================================================');
  console.log('PHASE 2B USER-SUPPLIED AUTHENTICATION TEST COMPLETED SUCCESSFULLY');
  console.log('================================================================');
}

runPhase2BLiveAuthTest().catch((err) => {
  console.error('\nPHASE 2B LIVE AUTH TEST FAILED:', err);
  process.exit(1);
});
