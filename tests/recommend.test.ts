import { describe, expect, it } from 'vitest';
import { voices } from '../shared/catalog';
import { recommend } from '../shared/recommend';
import { axes, neutralProfile, recipeSchema } from '../shared/schema';
import { loopbackUrl } from '../server/config';

describe('editorial voice recommendations', () => {
  it('ranks low, quiet profiles differently from bright ones', () => {
    const low = recommend(
      { pitch: 12, energy: 35, warmth: 50, airiness: 20 },
      { engine: 'all', budget: 'all' },
    );
    const bright = recommend(
      { pitch: 78, energy: 82, warmth: 75, airiness: 25 },
      { engine: 'all', budget: 'all' },
    );
    expect(low[0].voice.id).toBe('vv-ryusei');
    expect(bright[0].voice.id).toBe('vv-zundamon');
    expect(low.every((v, i) => i === 0 || v.score <= low[i - 1].score)).toBe(true);
  });
  it('honors incompatible engine and budget filters', () => {
    expect(recommend(neutralProfile, { engine: 'A.I.VOICE2', budget: 'free' })).toEqual([]);
    expect(
      recommend(neutralProfile, { engine: 'all', budget: 'free' }).every(
        (v) => v.voice.price === 'free',
      ),
    ).toBe(true);
  });
  it('keeps all recipes within bounds across profile extremes', () => {
    for (let mask = 0; mask < 16; mask++) {
      const profile = { ...neutralProfile };
      axes.forEach((axis, i) => {
        profile[axis] = mask & (1 << i) ? 100 : 0;
      });
      for (const result of recommend(profile, { engine: 'all', budget: 'all' })) {
        if (result.recipe) expect(recipeSchema.safeParse(result.recipe).success).toBe(true);
        else expect(result.voice.engine).not.toBe('VOICEVOX');
      }
    }
  });
  it('keeps whisper pitch unchanged and avoids unsupported numeric exports', () => {
    const results = recommend(neutralProfile, { engine: 'all', budget: 'all' });
    expect(results.find((v) => v.voice.id === 'vv-sora')?.recipe?.pitchScale).toBe(0);
    expect(
      results.filter((v) => v.voice.engine !== 'VOICEVOX').every((v) => v.recipe === null),
    ).toBe(true);
  });
  it('only includes unique curated voices with official HTTPS references', () => {
    expect(new Set(voices.map((v) => v.id)).size).toBe(voices.length);
    for (const voice of voices)
      for (const link of [voice.productUrl, voice.termsUrl, voice.docsUrl]) {
        const url = new URL(link);
        expect(url.protocol).toBe('https:');
        expect(['voicevox.hiroshiba.jp', 'coeiroink.com', 'aivoice.jp']).toContain(url.hostname);
      }
  });
});
describe('local service URLs', () => {
  it('accepts loopback URLs and rejects remote, credentialed, or path-based URLs', () => {
    expect(loopbackUrl('http://127.0.0.1:50021/')).toBe('http://127.0.0.1:50021');
    expect(loopbackUrl('http://[::1]:11434')).toBe('http://[::1]:11434');
    for (const value of [
      'https://example.com',
      'http://192.168.1.1',
      'http://user:pass@localhost',
      'http://localhost/redirect',
      'http://localhost?url=x',
    ])
      expect(() => loopbackUrl(value)).toThrow();
  });
});
