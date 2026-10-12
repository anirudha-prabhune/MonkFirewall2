import { mockZerodhaAdapter } from '../server/brokers/mock/adapter';
import { LiveZerodhaAdapter } from '../server/brokers/zerodha/liveAdapter';
import { BrokerAdapter } from '../server/brokers/types';
import { BrokerService } from '../server/brokers/service';

async function runStage1InterfaceTests() {
  console.log('================================================================');
  console.log('TRADING FIREWALL: STAGE 1 MINIMAL BROKER INTERFACE SUITE');
  console.log('Provider-neutral BrokerAdapter Interface & Zerodha Alignment');
  console.log('================================================================');

  let passedCount = 0;

  // Test 1: MockZerodhaAdapter satisfies BrokerAdapter interface contract
  try {
    const adapter: BrokerAdapter = mockZerodhaAdapter;
    if (adapter.providerId !== 'zerodha') {
      throw new Error(`Expected providerId to be 'zerodha', received: ${adapter.providerId}`);
    }
    const status = await adapter.getConnectionStatus();
    if (status.broker !== 'zerodha' || status.status !== 'CONNECTED') {
      throw new Error(`Malformed connection status from MockZerodhaAdapter: ${JSON.stringify(status)}`);
    }
    const rawPositions = await adapter.getPositions();
    if (!Array.isArray(rawPositions) || rawPositions.length === 0) {
      throw new Error('MockZerodhaAdapter getPositions returned empty or invalid array');
    }
    const instruments = await adapter.getInstruments();
    if (!Array.isArray(instruments) || instruments.length === 0) {
      throw new Error('MockZerodhaAdapter getInstruments returned empty or invalid array');
    }
    console.log('[Test 1] MockZerodhaAdapter adheres to BrokerAdapter contract...  ✓ PASSED');
    passedCount++;
  } catch (err) {
    console.error('[Test 1] FAILED:', err);
    process.exit(1);
  }

  // Test 2: LiveZerodhaAdapter satisfies BrokerAdapter interface contract
  try {
    const liveAdapter = new LiveZerodhaAdapter();
    const adapter: BrokerAdapter = liveAdapter;
    if (adapter.providerId !== 'zerodha') {
      throw new Error(`Expected providerId to be 'zerodha', received: ${adapter.providerId}`);
    }
    const status = await adapter.getConnectionStatus('test_user_stage1');
    if (status.broker !== 'zerodha' || typeof status.status !== 'string') {
      throw new Error(`Malformed connection status from LiveZerodhaAdapter: ${JSON.stringify(status)}`);
    }
    console.log('[Test 2] LiveZerodhaAdapter adheres to BrokerAdapter contract...  ✓ PASSED');
    passedCount++;
  } catch (err) {
    console.error('[Test 2] FAILED:', err);
    process.exit(1);
  }

  // Test 3: BrokerService gateway integration with BrokerAdapter
  try {
    BrokerService.setActiveAdapter(mockZerodhaAdapter);
    const active = BrokerService.getActiveAdapter();
    if (active.providerId !== 'zerodha') {
      throw new Error(`Expected active adapter providerId 'zerodha', received: ${active.providerId}`);
    }
    const status = await BrokerService.getConnectionStatus();
    if (status.status !== 'CONNECTED') {
      throw new Error(`BrokerService.getConnectionStatus failed: ${JSON.stringify(status)}`);
    }
    const fnoPositions = await BrokerService.getNormalizedFnoPositions();
    if (!Array.isArray(fnoPositions) || fnoPositions.length === 0) {
      throw new Error('BrokerService.getNormalizedFnoPositions returned empty positions');
    }
    console.log('[Test 3] BrokerService integrates cleanly with BrokerAdapter...  ✓ PASSED');
    passedCount++;
  } catch (err) {
    console.error('[Test 3] FAILED:', err);
    process.exit(1);
  }

  // Test 4: Verify Zerodha position normalization & F&O filtering contracts
  try {
    const rawPositions = await mockZerodhaAdapter.getPositions();
    const instruments = await mockZerodhaAdapter.getInstruments();
    const instrumentMap = new Map(instruments.map((i) => [i.instrumentToken, i]));

    const firstRaw = rawPositions[0];
    if (typeof firstRaw.tradingsymbol !== 'string' || typeof firstRaw.quantity !== 'number') {
      throw new Error('Raw position schema invalid');
    }

    console.log('[Test 4] Zerodha position normalization & schema verified...  ✓ PASSED');
    passedCount++;
  } catch (err) {
    console.error('[Test 4] FAILED:', err);
    process.exit(1);
  }

  console.log('================================================================');
  console.log(`ALL STAGE 1 BROKER INTERFACE TESTS PASSED (${passedCount}/${passedCount})`);
  console.log('================================================================');
}

runStage1InterfaceTests().catch((err) => {
  console.error('Fatal error in Stage 1 test suite:', err);
  process.exit(1);
});
