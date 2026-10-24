import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../server/config';
import { defaultAnthropicModel, defaultDeepseekModel, defaultGeminiModel } from '../shared/schema';

afterEach(() => {
  vi.unstubAllEnvs();
});
describe('Anthropic server configuration', () => {
  it('reads the key and model from server environment variables', () => {
    vi.stubEnv('ANTHROPIC_API_KEY', '  test-anthropic-config-key  ');
    vi.stubEnv('ANTHROPIC_MODEL', 'test-configured-claude');
    expect(loadConfig()).toMatchObject({
      anthropicKey: 'test-anthropic-config-key',
      anthropicModel: 'test-configured-claude',
    });
  });
  it('keeps Claude unconfigured until a key is supplied', () => {
    vi.stubEnv('ANTHROPIC_API_KEY', '  ');
    vi.stubEnv('ANTHROPIC_MODEL', '');
    expect(loadConfig()).toMatchObject({ anthropicKey: '', anthropicModel: defaultAnthropicModel });
  });
});

describe('Gemini server configuration', () => {
  it('reads the Gemini key and model from server environment variables', () => {
    vi.stubEnv('GEMINI_API_KEY', '  test-gemini-config-key  ');
    vi.stubEnv('GEMINI_MODEL', 'test-configured-gemini');
    expect(loadConfig()).toMatchObject({
      geminiKey: 'test-gemini-config-key',
      geminiModel: 'test-configured-gemini',
    });
  });
  it('keeps Gemini unconfigured until a key is supplied', () => {
    vi.stubEnv('GEMINI_API_KEY', '  ');
    vi.stubEnv('GEMINI_MODEL', '');
    expect(loadConfig()).toMatchObject({ geminiKey: '', geminiModel: defaultGeminiModel });
  });
});

describe('DeepSeek server configuration', () => {
  it('reads the key and model from server environment variables', () => {
    vi.stubEnv('DEEPSEEK_API_KEY', '  test-deepseek-config-key  ');
    vi.stubEnv('DEEPSEEK_MODEL', 'test-configured-deepseek');
    expect(loadConfig()).toMatchObject({
      deepseekKey: 'test-deepseek-config-key',
      deepseekModel: 'test-configured-deepseek',
    });
  });
  it('keeps DeepSeek unconfigured until a key is supplied', () => {
    vi.stubEnv('DEEPSEEK_API_KEY', '  ');
    vi.stubEnv('DEEPSEEK_MODEL', '');
    expect(loadConfig()).toMatchObject({ deepseekKey: '', deepseekModel: defaultDeepseekModel });
  });
});
