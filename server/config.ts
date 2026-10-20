import 'dotenv/config';
import { defaultAnthropicModel } from '../shared/schema';
export interface Config {
  port: number;
  ollamaUrl: string;
  ollamaModel: string;
  openaiKey: string;
  openaiModel: string;
  anthropicKey: string;
  anthropicModel: string;
  voicevoxUrl: string;
}
export function loopbackUrl(raw: string): string {
  const url = new URL(raw);
  if (
    url.protocol !== 'http:' ||
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !['', '/'].includes(url.pathname)
  ) {
    throw new Error(
      'ローカルサービスのURLには http://127.0.0.1:PORT などのループバックURLを指定してください。',
    );
  }
  return url.origin;
}
export function loadConfig(): Config {
  const port = Number(process.env.PORT || '3210');
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    throw new Error('PORTは1024〜65535で指定してください。');
  return {
    port,
    ollamaUrl: loopbackUrl(process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434'),
    ollamaModel: process.env.OLLAMA_MODEL || 'gemma3:4b',
    openaiKey: process.env.OPENAI_API_KEY || '',
    openaiModel: process.env.OPENAI_MODEL || 'gpt-4.1-mini',
    anthropicKey: (process.env.ANTHROPIC_API_KEY || '').trim(),
    anthropicModel: process.env.ANTHROPIC_MODEL || defaultAnthropicModel,
    voicevoxUrl: loopbackUrl(process.env.VOICEVOX_BASE_URL || 'http://127.0.0.1:50021'),
  };
}
