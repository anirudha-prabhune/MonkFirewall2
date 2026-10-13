import { BrokerAdapter } from './types';
import { mockZerodhaAdapter } from './mock/adapter';
import { liveZerodhaAdapter } from './zerodha/liveAdapter';
import { mockAngelOneAdapter } from './angelone/adapter';
import { liveAngelOneAdapter } from './angelone/liveAdapter';

/**
 * Broker Registry (Phase 1 Multi-Broker Integration).
 * Central registry managing broker adapters (Zerodha, Angel One, Mock).
 */
export class BrokerRegistry {
  private static adapters: Map<string, BrokerAdapter> = new Map<string, BrokerAdapter>([
    ['zerodha', liveZerodhaAdapter],
    ['zerodha-mock', mockZerodhaAdapter],
    ['angelone', liveAngelOneAdapter],
    ['angelone-mock', mockAngelOneAdapter],
  ]);

  public static registerAdapter(brokerId: string, adapter: BrokerAdapter): void {
    this.adapters.set(brokerId.toLowerCase().trim(), adapter);
  }

  public static getAdapter(brokerId: string = 'zerodha'): BrokerAdapter {
    const key = (brokerId || 'zerodha').toLowerCase().trim();
    const adapter = this.adapters.get(key) || this.adapters.get('zerodha');
    if (!adapter) {
      return mockZerodhaAdapter;
    }
    return adapter;
  }

  public static listBrokers(): string[] {
    return Array.from(this.adapters.keys());
  }
}
