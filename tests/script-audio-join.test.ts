import { describe, expect, it, vi } from 'vitest';
import { checkScriptAudioInput, joinScriptAudio } from '../shared/script-audio-join';
import { readPcmWav } from '../shared/wav';
import { scriptFixture } from './fixtures/script';
import { pcmWav } from './fixtures/wav';

const source = (values: number[], sampleRate = 24000, channels = 1) => ({
  blob: new Blob([pcmWav(values, sampleRate, channels)], { type: 'audio/wav' }),
  audition: { generation: null },
});

describe('script audio worker operation', () => {
  it('joins mixed PCM sources, keeps row Blobs intact and matches the manifest frames', async () => {
    const { script } = scriptFixture();
    script.gapMs = 1;
    const sources = [source([1000, 1000]), source([2000, 2000], 48000, 2)];
    const originals = await Promise.all(sources.map((s) => s.blob.arrayBuffer()));
    const result = await joinScriptAudio(script, sources);
    const wav = readPcmWav(result.bytes);
    expect(wav.frames).toBe(53);
    expect(wav.samples.getInt16(0, true)).toBe(1000);
    expect(wav.samples.getInt16(8, true)).toBe(0);
    expect(wav.samples.getInt16(104, true)).toBe(2000);
    expect(result.manifest.output.frames).toBe(wav.frames);
    expect(result.manifest.lines.map((line) => [line.startFrame, line.endFrame])).toEqual([
      [0, 4],
      [52, 53],
    ]);
    expect(await Promise.all(sources.map((s) => s.blob.arrayBuffer()))).toEqual(originals);
  });
  it('refuses count, schema and total capacity violations before reading audio', async () => {
    const { script } = scriptFixture();
    const read = vi.fn();
    const oversized = {
      blob: { size: 65 * 1024 * 1024, arrayBuffer: read } as unknown as Blob,
      audition: { generation: null },
    };
    expect(() => checkScriptAudioInput([])).toThrow('1〜20行');
    expect(() => checkScriptAudioInput(Array(21).fill(source([1])))).toThrow('1〜20行');
    await expect(joinScriptAudio(script, [oversized, source([1])])).rejects.toThrow('合計64MiB');
    await expect(joinScriptAudio(script, [source([1])])).rejects.toThrow('全行');
    await expect(
      joinScriptAudio({ ...script, gapMs: -1 }, [source([1]), source([1])]),
    ).rejects.toThrow();
    expect(read).not.toHaveBeenCalled();
  });
  it('rejects malformed PCM and mismatched generation provenance', async () => {
    const { script } = scriptFixture();
    const bad = source([1]);
    bad.blob = new Blob(['invalid']);
    await expect(joinScriptAudio(script, [bad, source([1])])).rejects.toThrow('結合できないWAV');
    await expect(
      joinScriptAudio(script, [
        {
          ...source([1]),
          audition: {
            generation: {
              engine: 'VOICEVOX',
              engineVersion: null,
              checkedAt: script.lines[0].assignment!.assignedAt,
            },
          },
        },
        source([1]),
      ]),
    ).rejects.toThrow('生成情報と話者');
  });
});
