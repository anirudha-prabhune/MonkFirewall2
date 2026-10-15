import { CredentialPresenceDiagnostic } from '../types';
import { AngelOneConfig } from './types';

export class AngelOneCredentials {
  private config: AngelOneConfig;

  constructor(config: AngelOneConfig = {}) {
    this.config = {
      apiKey: config.apiKey || '',
      clientCode: config.clientCode || '',
      password: config.password || '',
      totpSecret: config.totpSecret || '',
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
