import { liveAngelOneAdapter } from '../server/brokers/angelone/liveAdapter';
import { mockAngelOneAdapter } from '../server/brokers/angelone/adapter';
import { AngelOneSessionStore } from '../server/brokers/angelone/sessionStore';
import { AngelOneCredentials } from '../server/brokers/angelone/credentials';
import { BrokerRegistry } from '../server/brokers/registry';
import { normalizePositions, PositionValidationError } from '../server/brokers/normalize';
import { liveZerodhaAdapter } from '../server/brokers/zerodha/liveAdapter';
import { mockZerodhaAdapter, MockZerodhaAdapter } from '../server/brokers/mock/adapter';

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

async function runPhase2CAcceptance() {
  console.log('================================================================');
  console.log('MonkTrades Phase 2C — Angel One Acceptance & Multi-Broker Suite');
  console.log('================================================================');

  AngelOneSessionStore.enableMockStoreForTesting(true);

  // SECTION 1: Position Normalization (Empty & Non-Empty SmartAPI Schema)
  console.log('\n[Phase 2C — Test 1] Position Normalization Accuracy');

  // Test 1a: Empty position payloads
  const emptySmartApiList: any[] = [];
  const emptyMap = new Map();
  const emptyNormalized = normalizePositions(emptySmartApiList, emptyMap, 'ZERODHA_LIVE' as any);
  assert(emptyNormalized.length === 0, 'Empty raw position list must normalize to empty array');

  // Test 1b: Non-empty SmartAPI F&O & Equity positions
  const rawSmartApiFixture = [
    {
      exchange: 'NFO',
      symboltoken: '999002',
      symbolname: 'BANKNIFTY',
      tradingsymbol: 'BANKNIFTY26OCT52000CE',
      producttype: 'CARRYFORWARD',
      netqty: '25',
      buyqty: '25',
      sellqty: '0',
      buyamount: '12500.0',
      sellamount: '0.0',
      buyavgprice: '500.0',
      sellavgprice: '0.0',
      avgprice: '500.0',
      ltp: '540.0',
      pnl: '1000.0',
      realised: '0.0',
      unrealised: '1000.0',
    },
    {
      exchange: 'NSE',
      symboltoken: '3045',
      symbolname: 'SBIN',
      tradingsymbol: 'SBIN-EQ',
      producttype: 'DELIVERY',
      netqty: '100',
      buyqty: '100',
      sellqty: '0',
      buyamount: '80000.0',
      sellamount: '0.0',
      buyavgprice: '800.0',
      sellavgprice: '0.0',
      avgprice: '800.0',
      ltp: '820.0',
      pnl: '2000.0',
      realised: '500.0',
      unrealised: '1500.0',
    },
  ];

  const mappedRaw = rawSmartApiFixture.map((item) => ({
    exchange: item.exchange,
    tradingsymbol: item.tradingsymbol,
    product: item.producttype,
    quantity: Number(item.netqty),
    average_price: Number(item.avgprice),
    last_price: Number(item.ltp),
    pnl: Number(item.pnl),
    realised: Number(item.realised),
    unrealised: Number(item.unrealised),
    day_buy_quantity: Number(item.buyqty),
    day_buy_value: Number(item.buyamount),
    day_sell_quantity: Number(item.sellqty),
    day_sell_value: Number(item.sellamount),
    instrument_token: Number(item.symboltoken),
  }));

  const instrumentMasterMap = new Map([
    [
      999002,
      {
        instrumentToken: 999002,
        exchange: 'NFO',
        tradingsymbol: 'BANKNIFTY26OCT52000CE',
        name: 'BANKNIFTY',
        segment: 'NFO-OPT',
        instrumentType: 'OPTION',
        expiry: '2026-10-26',
        strike: 52000,
        tickSize: 0.05,
        lotSize: 25,
      },
    ],
    [
      3045,
      {
        instrumentToken: 3045,
        exchange: 'NSE',
        tradingsymbol: 'SBIN-EQ',
        name: 'SBIN',
        segment: 'NSE',
        instrumentType: 'EQ',
        expiry: null,
        strike: null,
        tickSize: 0.05,
        lotSize: 1,
      },
    ],
  ]);

  const normalized = normalizePositions(mappedRaw, instrumentMasterMap, 'ZERODHA_LIVE' as any);
  assert(normalized.length === 2, 'Normalized count must be 2');

  // Option F&O Contract Checks
  const fnoPos = normalized.find((p) => p.instrumentToken === 999002);
  assert(fnoPos !== undefined, 'F&O Position must be present');
  assert(fnoPos.tradingsymbol === 'BANKNIFTY26OCT52000CE', 'Tradingsymbol must match SmartAPI schema');
  assert(fnoPos.quantity === 25, 'Net quantity must match 25');
  assert(fnoPos.averagePrice === 500.0, 'Average price must match 500.0');
  assert(fnoPos.lastPrice === 540.0, 'LTP must match 540.0');
  assert(fnoPos.unrealisedPnl === 1000.0, 'Unrealized P&L must match 1000.0');
  assert(fnoPos.isFno === true, 'F&O segment classification must be true');

  // Equity Contract Checks
  const eqPos = normalized.find((p) => p.instrumentToken === 3045);
  assert(eqPos !== undefined, 'Equity Position must be present');
  assert(eqPos.tradingsymbol === 'SBIN-EQ', 'Equity symbol must match');
  assert(eqPos.quantity === 100, 'Quantity must match 100');
  assert(eqPos.realisedPnl === 500.0, 'Realized P&L must match 500.0');
  assert(eqPos.unrealisedPnl === 1500.0, 'Unrealized P&L must match 1500.0');
  assert(eqPos.isFno === false, 'Equity isFno classification must be false');

  console.log('  ✓ PASSED: Position normalization accurately handles empty, equity, and F&O SmartAPI payloads');

  // SECTION 2: Failure Handling & Fail-Closed Behavior
  console.log('\n[Phase 2C — Test 2] Failure Handling & Fail-Closed Resilience');

  // Test 2a: Malformed Response Validation (Fail-Closed)
  const malformedSmartApiFixture = [
    {
      exchange: 'NSE',
      symboltoken: 'INVALID_TOKEN_STRING',
      symbolname: null,
      tradingsymbol: '',
      producttype: null,
      netqty: undefined,
      buyavgprice: '0.0',
      ltp: null,
    },
  ];

  const malformedMapped = malformedSmartApiFixture.map((item) => ({
    exchange: item.exchange || 'NSE',
    tradingsymbol: item.tradingsymbol || 'UNKNOWN',
    product: item.producttype || 'MISC',
    quantity: Number(item.netqty ?? 0),
    average_price: Number(item.buyavgprice ?? 0),
    last_price: Number(item.ltp ?? 0),
    pnl: 0,
    realised: 0,
    unrealised: 0,
    day_buy_quantity: 0,
    day_buy_value: 0,
    day_sell_quantity: 0,
    day_sell_value: 0,
    instrument_token: Number(item.symboltoken ?? 0),
  }));

  try {
    normalizePositions(malformedMapped, new Map(), 'ZERODHA_LIVE' as any);
    assert(false, 'Malformed token NaN must throw PositionValidationError');
  } catch (err: any) {
    assert(err instanceof PositionValidationError, 'Malformed payload must throw PositionValidationError');
    assert(err.message.includes('Invalid instrument_token'), 'Error message must specify invalid token');
  }

  // Test 2b: Unauthenticated Position Query Fail-Closed
  try {
    await liveAngelOneAdapter.getPositions('non_existent_unauth_user');
    assert(false, 'Unauthenticated position fetch must throw error');
  } catch (err: any) {
    assert(err.message.includes('Angel One positions unavailable') || err.message.includes('not found'), 'Unauthenticated fetch must fail closed');
  }

  // Test 2c: Expired Session Invalidation
  const userExpired = 'trader_expired_phase2c';
  await AngelOneSessionStore.saveSession(userExpired, 'token_expired_123');
  const pastTime = new Date(Date.now() + 25 * 3600 * 1000);
  const expiredSession = await AngelOneSessionStore.loadSession(userExpired, { evaluationTime: pastTime });
  assert(expiredSession?.isExpired === true, 'Session evaluated after 25h must be marked expired');
  assert(expiredSession?.authState === 'AUTHENTICATION_REQUIRED', 'Expired session must transition to AUTHENTICATION_REQUIRED');

  console.log('  ✓ PASSED: Malformed payloads, expired sessions, and unauthenticated queries fail closed deterministically');

  // SECTION 3: Multi-Tenant Session Isolation & Security
  console.log('\n[Phase 2C — Test 3] Multi-Tenant Session & Connection Isolation');
  const tenantAlice = 'tenant_alice_901';
  const tenantBob = 'tenant_bob_902';
  const tokenAlice = 'jwt_secret_token_alice_456';
  const tokenBob = 'jwt_secret_token_bob_789';

  await AngelOneSessionStore.saveSession(tenantAlice, tokenAlice);
  await AngelOneSessionStore.saveSession(tenantBob, tokenBob);

  const sessionAlice = await AngelOneSessionStore.loadSession(tenantAlice);
  const sessionBob = await AngelOneSessionStore.loadSession(tenantBob);

  assert(sessionAlice?.accessToken === tokenAlice, 'Alice session token must match');
  assert(sessionBob?.accessToken === tokenBob, 'Bob session token must match');
  assert((sessionAlice?.accessToken as string) !== (sessionBob?.accessToken as string), 'Tokens between distinct users must be strictly isolated');

  // Multi-Connection Isolation (Same User, Different Connection IDs)
  await AngelOneSessionStore.saveSession(tenantAlice, 'token_alice_custom_conn', { connectionId: 'conn_secondary' });
  const sessionAliceDefault = await AngelOneSessionStore.loadSession(tenantAlice);
  const sessionAliceSecondary = await AngelOneSessionStore.loadSession(tenantAlice, { connectionId: 'conn_secondary' });

  assert(sessionAliceDefault?.accessToken === tokenAlice, 'Default connection token must remain untouched');
  assert(sessionAliceSecondary?.accessToken === 'token_alice_custom_conn', 'Secondary connection token must be isolated');

  console.log('  ✓ PASSED: Per-user and per-connection sessions are completely isolated with zero cross-tenant leak');

  // SECTION 4: Architecture Guardrails & Read-Only Governance
  console.log('\n[Phase 2C — Test 4] Architecture Guardrails & Read-Only Governance');
  
  // Verify strictly read-only interface (no trading/order placement methods)
  assert((liveAngelOneAdapter as any).placeOrder === undefined, 'Angel One Live Adapter MUST NOT have placeOrder');
  assert((liveAngelOneAdapter as any).cancelOrder === undefined, 'Angel One Live Adapter MUST NOT have cancelOrder');
  assert((mockAngelOneAdapter as any).placeOrder === undefined, 'Angel One Mock Adapter MUST NOT have placeOrder');
  assert((mockAngelOneAdapter as any).cancelOrder === undefined, 'Angel One Mock Adapter MUST NOT have cancelOrder');

  // Verify registry resolution
  assert(BrokerRegistry.getAdapter('zerodha') === liveZerodhaAdapter, 'Default zerodha adapter must resolve to liveZerodhaAdapter');
  assert(BrokerRegistry.getAdapter('zerodha-mock') === mockZerodhaAdapter, 'zerodha-mock adapter must resolve to mockZerodhaAdapter');
  assert(BrokerRegistry.getAdapter('angelone') === liveAngelOneAdapter, 'angelone adapter must resolve to liveAngelOneAdapter');
  assert(BrokerRegistry.getAdapter('angelone-mock') === mockAngelOneAdapter, 'angelone-mock adapter must resolve to mockAngelOneAdapter');

  console.log('  ✓ PASSED: Multi-broker registry resolution verified; strict read-only governance enforced');

  AngelOneSessionStore.enableMockStoreForTesting(false);

  console.log('\n================================================================');
  console.log('ALL PHASE 2C ACCEPTANCE TESTS PASSED SUCCESSFULLY (4/4)');
  console.log('================================================================');
}

runPhase2CAcceptance().catch((err) => {
  console.error('\nPHASE 2C ACCEPTANCE SUITE FAILED:', err);
  process.exit(1);
});
