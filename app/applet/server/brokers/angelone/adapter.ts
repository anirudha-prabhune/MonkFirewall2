import {
  BrokerAdapter,
  BrokerConnectionStatus,
  RawBrokerPosition,
  BrokerInstrument,
} from '../types';
import { AngelOneCredentials } from './credentials';
import { MOCK_INSTRUMENT_MASTER } from '../../instruments/master';

/**
 * Mock Angel One Broker Adapter (SmartAPI Sandbox).
 */
export class MockAngelOneAdapter implements BrokerAdapter {
  public readonly providerId: string = 'angelone';
  private credentials: AngelOneCredentials;
  private isConnected: boolean = true;

  constructor(config = {}) {
    this.credentials = new AngelOneCredentials(config);
  }

  public async getConnectionStatus(userId?: string): Promise<BrokerConnectionStatus> {
    const configured = this.credentials.isConfigured() || true;
    return {
      broker: 'angelone',
      status: this.isConnected ? 'CONNECTED' : 'DISCONNECTED',
      isMock: true,
      message: 'Mock Angel One SmartAPI Adapter connected',
      timestamp: new Date().toISOString(),
      configured,
      authenticated: this.isConnected,
      credentials: this.credentials.getDiagnostic(),
    };
  }

  public async getPositions(userId?: string): Promise<RawBrokerPosition[]> {
    return [
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
        multiplier: 50,
      },
    ];
  }

  public async getInstruments(userId?: string): Promise<BrokerInstrument[]> {
    return JSON.parse(JSON.stringify(MOCK_INSTRUMENT_MASTER));
  }

  public setConnected(connected: boolean): void {
    this.isConnected = connected;
  }
}

export const mockAngelOneAdapter = new MockAngelOneAdapter();
