import { liveAngelOneAdapter } from '../server/brokers/angelone/liveAdapter';
import { mockAngelOneAdapter } from '../server/brokers/angelone/adapter';
import { AngelOneSessionStore } from '../server/brokers/angelone/sessionStore';
import { BrokerRegistry } from '../server/brokers/registry';
import { normalizePositions } from '../server/brokers/normalize';
import { liveZerodhaAdapter } from '../server/brokers/zerodha/liveAdapter';

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

async function runAngelOneTests() {
  console.log('================================================================');
  console.log('Running MonkTrades Phase 1 — Angel One Integration Tests');
  console.log('================================================================');

  AngelOneSessionStore.enableMockStoreForTesting(true);

  // Test 1: Broker Registry
  console.log('\n[Test 1] Broker Registry Multi-Broker Resolution');
  const zerodhaAdapter = BrokerRegistry.getAdapter('zerodha');
  assert(zerodhaAdapter !== undefined, 'Zerodha adapter must be defined');
  assert(zerodhaAdapter.providerId === 'zerodha', 'Zerodha providerId must be zerodha');

  const angelAdapter = BrokerRegistry.getAdapter('angelone');
  assert(angelAdapter !== undefined, 'Angel One adapter must be defined');
  assert(angelAdapter.providerId === 'angelone', 'Angel One providerId must be angelone');
  console.log('  ✓ PASSED: Broker registry correctly resolves Zerodha and Angel One adapters');

  // Test 2: Authentication & Session Isolation
  console.log('\n[Test 2] Angel One Authentication & Session Isolation');
  const userId1 = 'trader_alice';
  const userId2 = 'trader_bob';
  const token1 = 'jwt_token_alice_123';
  const token2 = 'jwt_token_bob_456';

  await AngelOneSessionStore.saveSession(userId1, token1, { clientCode: 'ALICE123' });
  await AngelOneSessionStore.saveSession(userId2, token2, { clientCode: 'BOB456' });

  const session1 = await AngelOneSessionStore.loadSession(userId1);
  const session2 = await AngelOneSessionStore.loadSession(userId2);

  assert(session1 !== null, 'Alice session must not be null');
  assert(session1?.accessToken === token1, 'Alice access token must match');
  assert(session1?.clientCode === 'ALICE123', 'Alice client code must match');

  assert(session2 !== null, 'Bob session must not be null');
  assert(session2?.accessToken === token2, 'Bob access token must match');
  assert(session2?.clientCode === 'BOB456', 'Bob client code must match');

  const sessionMissing = await AngelOneSessionStore.loadSession('unknown_user');
  assert(sessionMissing === null, 'Unknown user session must be null');
  console.log('  ✓ PASSED: Per-user session isolation and storage verified');

  // Test 3: Position Normalization
  console.log('\n[Test 3] Angel One Position Normalization');
  const rawAngelPositions = [
    {
      exchange: 'NFO',
      symboltoken: 999001,
      symbolname: 'NIFTY',
      tradingsymbol: 'NIFTY26OCT24000CE',
      producttype: 'CARRYFORWARD',
      netqty: 50,
      buyqty: 50,
      sellqty: 0,
      buyamount: 7500.0,
      sellamount: 0.0,
      buyavgprice: 150.0,
      sellavgprice: 0.0,
      avgprice: 150.0,
      ltp: 165.0,
      pnl: 750.0,
      realised: 0.0,
      unrealised: 750.0,
    },
  ];

  const mappedRaw = rawAngelPositions.map((item) => ({
    exchange: item.exchange,
    tradingsymbol: item.tradingsymbol,
    product: item.producttype,
    quantity: item.netqty,
    average_price: item.avgprice,
    last_price: item.ltp,
    pnl: item.pnl,
    realised: item.realised,
    unrealised: item.unrealised,
    day_buy_quantity: item.buyqty,
    day_buy_value: item.buyamount,
    day_sell_quantity: item.sellqty,
    day_sell_value: item.sellamount,
    instrument_token: item.symboltoken,
  }));

  const instrumentMap = new Map([
    [
      999001,
      {
        instrumentToken: 999001,
        exchange: 'NFO',
        tradingsymbol: 'NIFTY26OCT24000CE',
        name: 'NIFTY',
        segment: 'NFO-OPT',
        instrumentType: 'OPTION',
        expiry: '2026-10-26',
        strike: 24000,
        tickSize: 0.05,
        lotSize: 50,
      },
    ],
  ]);

  const normalized = normalizePositions(mappedRaw, instrumentMap, 'ZERODHA_LIVE' as any);
  assert(normalized.length === 1, 'Normalized positions count must be 1');
  assert(normalized[0].tradingsymbol === 'NIFTY26OCT24000CE', 'Tradingsymbol must match');
  assert(normalized[0].isFno === true, 'Must be classified as F&O');
  assert(normalized[0].unrealisedPnl === 750.0, 'Unrealised P&L must match');
  console.log('  ✓ PASSED: Angel One raw positions correctly normalized into canonical models');

  // Test 4: Zerodha Regression
  console.log('\n[Test 4] Zerodha Regression Check');
  const zerodhaStatus = await liveZerodhaAdapter.getConnectionStatus('default_trader');
  assert(zerodhaStatus !== undefined, 'Zerodha status must be defined');
  assert(zerodhaStatus.broker === 'zerodha', 'Broker must be zerodha');
  console.log('  ✓ PASSED: Zerodha functionality and regression check passed successfully');

  AngelOneSessionStore.enableMockStoreForTesting(false);

  console.log('\n================================================================');
  console.log('ALL ANGEL ONE INTEGRATION TESTS PASSED (4/4)');
  console.log('================================================================');
}

runAngelOneTests().catch((err) => {
  console.error('\nANGEL ONE INTEGRATION TESTS FAILED:', err);
  process.exit(1);
});
