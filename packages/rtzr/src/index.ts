export interface RtzrConfig {
  clientId: string;
  clientSecret: string;
  apiBaseUrl: string;
}

export interface RtzrTranscript {
  id: string;
  text: string;
  raw: unknown;
}
