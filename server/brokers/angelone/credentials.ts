import { CredentialPresenceDiagnostic } from '../types';
import { AngelOneConfig } from './types';

export class AngelOneCredentials {
  private config: AngelOneConfig;

  constructor(config: AngelOneConfig = {}) {
    this.config = {
      apiKey: config.apiKey !== undefined ? config.apiKey : process.env.ANGELONE_API_KEY,
      clientCode: config.clientCode !== undefined ? config.clientCode : process.env.ANGELONE_CLIENT_CODE,
      password: config.password !== undefined ? config.password : process.env.ANGELONE_PASSWORD,
      totpSecret: config.totpSecret !== undefined ? config.totpSecret : process.env.ANGELONE_TOTP_SECRET,
    };
  }

  public isConfigured(): boolean {
    return Boolean(this.config.apiKey && this.config.clientCode && this.config.password);
  }

  public getConfig(): AngelOneConfig {
    return { ...this.config };
  }

  public getDiagnostic(): CredentialPresenceDiagnostic {
    return {
      apiKeyConfigured: Boolean(this.config.apiKey),
      accessTokenConfigured: Boolean(this.config.clientCode),
      apiSecretConfigured: Boolean(this.config.password),
      totpSecretConfigured: Boolean(this.config.totpSecret),
    };
  }
}
