import { CredentialPresenceDiagnostic } from '../types';
import { AngelOneConfig } from './types';

export class AngelOneCredentials {
  private config: AngelOneConfig;

  constructor(config: AngelOneConfig = {}) {
    this.config = {
      apiKey: process.env.ANGELONE_API_KEY || config.apiKey,
      clientCode: process.env.ANGELONE_CLIENT_CODE || config.clientCode,
      password: process.env.ANGELONE_PASSWORD || config.password,
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
    };
  }
}
