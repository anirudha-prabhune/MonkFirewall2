import { BrokerConnectionStatus, CredentialPresenceDiagnostic } from '../types';

export interface AngelOneConfig {
  apiKey?: string;
  clientCode?: string;
  password?: string;
  totpSecret?: string;
  totp?: string;
}

export interface RawAngelOnePosition {
  exchange: string;
  symboltoken: string;
  symbolname: string;
  tradingsymbol: string;
  producttype: string;
  netqty: number;
  buyqty: number;
  sellqty: number;
  buyamount: number;
  sellamount: number;
  buyavgprice: number;
  sellavgprice: number;
  avgprice: number;
  ltp: number;
  pnl: number;
  realised: number;
  unrealised: number;
  closeprice?: number;
}

export interface AngelOneConnectionStatus extends BrokerConnectionStatus {
  broker: 'angelone';
  clientCode?: string;
}
