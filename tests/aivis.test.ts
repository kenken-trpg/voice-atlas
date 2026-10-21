import { describe, expect, it, vi } from 'vitest';
import { createAivisClient, aivisRecipeSchema } from '../server/tts/aivis';

const uuid = '11111111-1111-4111-8111-111111111111';
const target = { speakerUuid: uuid, styleName: 'ノーマル' };
const inventory = [
  { name: '検証用話者', speaker_uuid: uuid, styles: [{ name: 'ノーマル', id: -123 }] },
];
const query = {
  accent_phrases: [],
  kana: 'エンジンが返した読み',
  outputSamplingRate: 44100,
  outputStereo: false,
  extraField: 'preserve',
};
const wav = Buffer.alloc(44);
wav.write('RIFF');
wav.write('WAVE', 8);
const request = {
  target,
  text: '  これは検証です。  ',
  recipe: { engine: 'AivisSpeech' as const },
};
function fixture() {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) => {
    const path = new URL(String(url)).pathname;
    if (path === '/speakers') return Response.json(inventory);
    if (path === '/audio_query') return Response.json(query);
    if (path === '/synthesis') return new Response(wav);
    if (path === '/version') return Response.json('1.0.0-test');
    throw new Error('Unexpected request');
  });
  return { fetcher, client: createAivisClient('http://127.0.0.1:10101', fetcher) };
}
describe('AivisSpeech experimental protocol', () => {
  it('resolves signed style IDs by UUID/name and preserves the engine query with native controls', async () => {
    const { fetcher, client } = fixture();
    const result = await client.synthesize({
      ...request,
      recipe: { engine: 'AivisSpeech', intonationScale: 1.2, tempoDynamicsScale: 0.7 },
    });
    expect(result.wav).toEqual(wav);
    expect(result.evidence).toMatchObject({
      engine: 'AivisSpeech',
      engineVersion: '1.0.0-test',
      speakerUuid: uuid,
      observedStyleId: -123,
      text: 'これは検証です。',
    });
    expect(fetcher.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual([
      '/speakers',
      '/audio_query',
      '/synthesis',
      '/version',
    ]);
    expect(new URL(String(fetcher.mock.calls[1][0])).searchParams.get('speaker')).toBe('-123');
    const body = JSON.parse(String(fetcher.mock.calls[2][1]?.body));
    expect(body).toEqual({
      ...query,
      kana: 'これは検証です。',
      speedScale: 1,
      intonationScale: 1.2,
      tempoDynamicsScale: 0.7,
      pitchScale: 0,
      volumeScale: 1,
      prePhonemeLength: 0.1,
      postPhonemeLength: 0.1,
    });
    expect(fetcher.mock.calls.every(([, init]) => init?.redirect === 'error')).toBe(true);
  });
  it('refreshes numeric IDs on every synthesis', async () => {
    const { client, fetcher } = fixture();
    await client.synthesize(request);
    fetcher.mockImplementation(async (url) => {
      const path = new URL(String(url)).pathname;
      if (path === '/speakers')
        return Response.json([{ ...inventory[0], styles: [{ name: 'ノーマル', id: 456 }] }]);
      if (path === '/audio_query') return Response.json(query);
      if (path === '/synthesis') return new Response(wav);
      return Response.json('1.0.1-test');
    });
    expect((await client.synthesize(request)).evidence.observedStyleId).toBe(456);
  });
  it.each(['http://example.com:10101', 'https://127.0.0.1:10101', 'http://127.0.0.1:10101/path'])(
    'rejects unsafe endpoint %s',
    (url) => {
      expect(() => createAivisClient(url)).toThrow();
    },
  );
  it('rejects invalid inputs and VOICEVOX recipes before any network access', async () => {
    const { client, fetcher } = fixture();
    await expect(client.synthesize({ ...request, text: '   ' })).rejects.toThrow();
    await expect(
      client.synthesize({ ...request, target: { ...target, speakerUuid: 'invalid' } }),
    ).rejects.toThrow();
    await expect(
      client.synthesize({ ...request, recipe: { engine: 'AivisSpeech', tempoDynamicsScale: 3 } }),
    ).rejects.toThrow();
    expect(aivisRecipeSchema.safeParse({ speedScale: 1, intonationScale: 1 }).success).toBe(false);
    expect(aivisRecipeSchema.safeParse({ engine: 'VOICEVOX' }).success).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([
    [],
    [{ ...inventory[0], speaker_uuid: '22222222-2222-4222-8222-222222222222' }],
    [{ ...inventory[0], styles: [{ name: 'ノーマル', id: -123, type: 'sing' }] }],
    [inventory[0], inventory[0]],
    [
      {
        ...inventory[0],
        styles: [
          { name: 'ノーマル', id: -123 },
          { name: '別スタイル', id: -123 },
        ],
      },
    ],
  ])('refuses missing, ambiguous or colliding styles (%#)', async (...items) => {
    const { client, fetcher } = fixture();
    // Vitest expands each array row into positional arguments.
    fetcher.mockResolvedValue(Response.json(items));
    await expect(client.synthesize(request)).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('rejects invalid inventory, invalid queries and invalid audio before fetching version', async () => {
    for (const failPath of ['/speakers', '/audio_query', '/synthesis']) {
      const { client, fetcher } = fixture();
      const original = fetcher.getMockImplementation()!;
      fetcher.mockImplementation(async (url, init) =>
        new URL(String(url)).pathname === failPath
          ? Response.json({ invalid: true })
          : original(url, init),
      );
      await expect(client.synthesize(request)).rejects.toThrow();
      expect(fetcher.mock.calls.some(([url]) => String(url).endsWith('/version'))).toBe(false);
    }
  });
  it('keeps valid audio when optional version information is unavailable', async () => {
    const { client, fetcher } = fixture();
    const original = fetcher.getMockImplementation()!;
    fetcher.mockImplementation(async (url, init) => {
      if (String(url).endsWith('/version')) throw new Error('offline');
      return original(url, init);
    });
    const result = await client.synthesize(request);
    expect(result.wav).toEqual(wav);
    expect(result.evidence.engineVersion).toBeNull();
  });
});
