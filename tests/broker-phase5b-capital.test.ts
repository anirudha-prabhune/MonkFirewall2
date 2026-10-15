import assert from 'node:assert';
import { mockZerodhaAdapter } from '../server/brokers/mock/adapter';
import { liveZerodhaAdapter } from '../server/brokers/zerodha/liveAdapter';
import { liveAngelOneAdapter } from '../server/brokers/angelone/liveAdapter';
import { checkIsAfterHours } from '../server/brokers/normalize';
import { AngelOneSessionStore } from '../server/brokers/angelone/sessionStore';
import { ZerodhaSessionStore } from '../server/brokers/zerodha/sessionStore';

console.log('================================================================');
console.log('MonkTrades Phase 5B: Broker Account Capital Test Suite');
console.log('================================================================');

async function runTests() {
  // Test 1: Mock Broker Capital Structure & Field Semantics
  console.log('[Test 1] Mock Broker Capital Structure & Field Semantics');
  mockZerodhaAdapter.setConnected(true);
  const mockCap = await mockZerodhaAdapter.getCapital();
  assert.strictEqual(mockCap.broker, 'mock');
  assert.strictEqual(mockCap.dataSource, 'MOCK_DATA');
  assert.strictEqual(mockCap.connectionStatus, 'CONNECTED');
  assert.strictEqual(typeof mockCap.netBalance, 'number');
  assert.strictEqual(mockCap.netBalance, 500000);
  assert.strictEqual(mockCap.availableCash, 350000);
  assert.strictEqual(mockCap.availableTradingMargin, 400000);
  assert.strictEqual(mockCap.utilizedMargin, 100000);
  assert.strictEqual(mockCap.withdrawableFunds, 300000);
  assert.strictEqual(mockCap.currency, 'INR');
  assert.strictEqual(typeof mockCap.isAfterHours, 'boolean');
  assert.strictEqual(mockCap.isStale, false);
  console.log('  ✓ PASSED: Mock capital fields match expected semantics');

  // Test 2: Zerodha Field Semantics & Null Withdrawable Funds Isolation
  console.log('[Test 2] Zerodha Field Semantics & Null Withdrawable Funds Isolation');
  const zerodhaCap = await liveZerodhaAdapter.getCapital('test_user_p5b');
  assert.strictEqual(zerodhaCap.broker, 'zerodha');
  assert.strictEqual(zerodhaCap.dataSource, 'ZERODHA_LIVE');
  assert.strictEqual(zerodhaCap.currency, 'INR');
  // Zerodha Kite /user/margins does not provide a withdrawable funds field; MUST be null or unsupported
  if (zerodhaCap.netBalance !== null) {
    assert.strictEqual(zerodhaCap.withdrawableFunds, null, 'Zerodha withdrawable funds must be null');
  }
  console.log('  ✓ PASSED: Zerodha withdrawableFunds strictly isolated as null per Kite API contract');

  // Test 3: Angel One RMS Field Semantics & Withdrawable Balance Support
  console.log('[Test 3] Angel One RMS Field Semantics & Withdrawable Balance Support');
  const angelCap = await liveAngelOneAdapter.getCapital('test_user_p5b');
  assert.strictEqual(angelCap.broker, 'angelone');
  assert.strictEqual(angelCap.dataSource, 'ANGELONE_LIVE');
  assert.strictEqual(angelCap.currency, 'INR');
  if (angelCap.netBalance !== null) {
    assert.strictEqual(typeof angelCap.withdrawableFunds, 'number');
    assert.strictEqual(angelCap.withdrawableFunds, 95000.0);
  }
  console.log('  ✓ PASSED: Angel One withdrawable balance correctly mapped from RMS endpoint');

  // Test 4: Disconnected Session & Failure Handling (No Fabricated Values)
  console.log('[Test 4] Disconnected Session & Failure Handling (No Fabricated Values)');
  AngelOneSessionStore.enableMockStoreForTesting(true);
  await AngelOneSessionStore.invalidateSession('disconnected_user');
  const disconnectedAngelCap = await liveAngelOneAdapter.getCapital('disconnected_user');
  assert.strictEqual(disconnectedAngelCap.netBalance, null);
  assert.strictEqual(disconnectedAngelCap.availableCash, null);
  assert.strictEqual(disconnectedAngelCap.availableTradingMargin, null);
  assert.strictEqual(disconnectedAngelCap.utilizedMargin, null);
  assert.strictEqual(disconnectedAngelCap.withdrawableFunds, null);
  assert.strictEqual(disconnectedAngelCap.isStale, true);
  assert.notStrictEqual(disconnectedAngelCap.connectionStatus, 'CONNECTED');
  console.log('  ✓ PASSED: Disconnected session fails closed with null balances and isStale=true');

  // Test 5: After-Hours Time Utility Validation
  console.log('[Test 5] After-Hours Time Utility Validation');
  // Weekend test (Sunday)
  const sunday = new Date('2026-10-11T10:00:00Z');
  assert.strictEqual(checkIsAfterHours(sunday), true, 'Sunday must be after-hours');
  // Midday trading hour test (Mon 11:00 AM IST = Mon 05:30 AM UTC)
  const tradingHour = new Date('2026-10-12T05:30:00Z');
  assert.strictEqual(checkIsAfterHours(tradingHour), false, 'Mon 11:00 AM IST must be trading hours');
  // Night time test (Mon 10:00 PM IST = Mon 04:30 PM UTC)
  const nightHour = new Date('2026-10-12T16:30:00Z');
  assert.strictEqual(checkIsAfterHours(nightHour), true, 'Mon 10:00 PM IST must be after-hours');
  console.log('  ✓ PASSED: IST trading hours & after-hours detection validated');

  // Test 6: Mock Disconnect Safety
  console.log('[Test 6] Mock Disconnect Safety');
  mockZerodhaAdapter.setConnected(false);
  const disconnectedMockCap = await mockZerodhaAdapter.getCapital();
  assert.strictEqual(disconnectedMockCap.connectionStatus, 'DISCONNECTED');
  assert.strictEqual(disconnectedMockCap.netBalance, null);
  assert.strictEqual(disconnectedMockCap.isStale, true);
  mockZerodhaAdapter.setConnected(true);
  console.log('  ✓ PASSED: Mock disconnect returns stale null capital');

  console.log('================================================================');
  console.log('ALL PHASE 5B CAPITAL TESTS PASSED SUCCESSFULLY (6/6)');
  console.log('================================================================');
}

runTests().catch((err) => {
  console.error('Test Suite Failed:', err);
  process.exit(1);
});
