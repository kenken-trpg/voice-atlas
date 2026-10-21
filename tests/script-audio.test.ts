import { describe, expect, it } from 'vitest';
import {
  checkJoinedFrames,
  encodeJoinedWav,
  joinedSampleRate,
  maxJoinedBytes,
  normalizePcm,
  readPcmWav,
} from '../shared/wav';
import { makeScriptAudioManifest } from '../shared/script-audio';
import { parseScript, serializeScript } from '../shared/script';
import { scriptFixture } from './fixtures/script';
import { pcmWav } from './fixtures/wav';

describe('script WAV output', () => {
  it('preserves 48kHz PCM samples and line order, adds silence only between rows', () => {
    const a = normalizePcm(readPcmWav(pcmWav([-32768, 32767], 48000)));
    const b = normalizePcm(readPcmWav(pcmWav([123, -456], 48000)));
    const joined = readPcmWav(encodeJoinedWav([a, b], 2));
    expect(joined.sampleRate).toBe(joinedSampleRate);
    expect(joined.channels).toBe(1);
    expect(
      Array.from({ length: joined.frames }, (_, i) => joined.samples.getInt16(i * 2, true)),
    ).toEqual([-32768, 32767, 0, 0, 123, -456]);
    expect(readPcmWav(encodeJoinedWav([a], 24000)).frames).toBe(2);
    expect(readPcmWav(encodeJoinedWav([a, b], 0)).frames).toBe(4);
  });
  it('normalizes mixed sample rates and downmixes stereo without overflow', () => {
    expect([...normalizePcm(readPcmWav(pcmWav([0, 1000], 24000)))]).toEqual([0, 500, 1000, 1000]);
    expect([
      ...normalizePcm(readPcmWav(pcmWav([32767, -32767, -32768, -32768], 48000, 2))),
    ]).toEqual([0, -32768]);
    expect(normalizePcm(readPcmWav(pcmWav(Array(441).fill(1000), 44100))).length).toBe(480);
  });
  it('accepts unknown padded chunks and locates data before fmt without hardcoding offsets', () => {
    const original = pcmWav([123, 456], 48000);
    const bytes = new Uint8Array(original.length + 10);
    bytes.set(original.subarray(0, 12));
    bytes.set([74, 85, 78, 75, 1, 0, 0, 0, 9, 0], 12);
    bytes.set(original.subarray(12), 22);
    new DataView(bytes.buffer).setUint32(4, bytes.length - 8, true);
    expect([...normalizePcm(readPcmWav(bytes))]).toEqual([123, 456]);
    const reordered = new Uint8Array(original.length);
    reordered.set(original.subarray(0, 12));
    reordered.set(original.subarray(36), 12);
    reordered.set(original.subarray(12, 36), 24);
    expect([...normalizePcm(readPcmWav(reordered))]).toEqual([123, 456]);
  });
  it('rejects malformed, truncated and unsupported WAV files without allocating based on declared sizes', () => {
    for (const mutate of [
      (v: DataView) => v.setUint32(4, 0xffffffff, true),
      (v: DataView) => v.setUint32(16, 0xffffffff, true),
      (v: DataView) => v.setUint16(20, 3, true),
      (v: DataView) => v.setUint16(22, 3, true),
      (v: DataView) => v.setUint32(24, 192000, true),
      (v: DataView) => v.setUint32(28, 123, true),
      (v: DataView) => v.setUint16(32, 4, true),
      (v: DataView) => v.setUint16(34, 8, true),
      (v: DataView) => v.setUint32(40, 0, true),
      (v: DataView) => v.setUint32(40, 3, true),
    ]) {
      const bytes = pcmWav([1, 2]);
      mutate(new DataView(bytes.buffer));
      expect(() => readPcmWav(bytes)).toThrow();
    }
    expect(() => readPcmWav(pcmWav([1, 2]).subarray(0, 43))).toThrow();
    expect(() => readPcmWav(pcmWav([1, 2, 3], 24000, 2))).toThrow();
  });
  it('guards total output size, row count and gap before allocation', () => {
    expect(() => checkJoinedFrames((maxJoinedBytes - 44) / 2 + 1)).toThrow();
    expect(() => checkJoinedFrames(Infinity)).toThrow();
    expect(() => encodeJoinedWav([], 0)).toThrow();
    expect(() => encodeJoinedWav([new Int16Array()], 1)).toThrow();
    expect(() => encodeJoinedWav([new Int16Array([1])], -1)).toThrow();
    expect(() => encodeJoinedWav([new Int16Array([1])], 240001)).toThrow();
  });
  it('records exact sample positions, fresh evidence and immutable native settings for the exported WAV', () => {
    const { script } = scriptFixture();
    script.gapMs = 250;
    const manifest = makeScriptAudioManifest(script, [
      { frames: 24000, source: { sampleRate: 24000, channels: 1 }, audition: { generation: null } },
      {
        frames: 48000,
        source: { sampleRate: 44100, channels: 2 },
        audition: {
          generation: {
            engine: 'VOICEVOX',
            engineVersion: 'current',
            checkedAt: script.lines[0].assignment!.assignedAt,
          },
        },
      },
    ]);
    expect(manifest.lines.map((line) => [line.startFrame, line.endFrame])).toEqual([
      [0, 24000],
      [36000, 84000],
    ]);
    expect(manifest.lines[1].startMs).toBe(750);
    expect(manifest.output.durationMs).toBe(1750);
    expect(manifest.lines[0].audition.generation).toBeNull();
    script.lines[0].text = '後から変更';
    expect(manifest.script.lines[0].text).toBe('ようこそ。');
    expect(manifest.wavFileName).toContain(manifest.id);
    expect(() => makeScriptAudioManifest(script, [])).toThrow();
    expect(() =>
      makeScriptAudioManifest(script, [
        { frames: 1, source: { sampleRate: 48000, channels: 1 }, audition: { generation: null } },
      ]),
    ).toThrow();
  });
  it('loads older scripts with a default gap, validates gap bounds, refuses mismatched provenance', () => {
    const { script } = scriptFixture();
    const old = JSON.parse(serializeScript(script));
    delete old.gapMs;
    expect(parseScript(JSON.stringify(old)).gapMs).toBe(300);
    for (const gapMs of [-1, 5001, 0.5, '100'])
      expect(() => parseScript(JSON.stringify({ ...old, gapMs }))).toThrow();
    expect(() =>
      makeScriptAudioManifest(script, [
        {
          frames: 1,
          source: { sampleRate: 48000, channels: 1 },
          audition: {
            generation: {
              engine: 'VOICEVOX',
              engineVersion: null,
              checkedAt: script.lines[0].assignment!.assignedAt,
            },
          },
        },
        { frames: 1, source: { sampleRate: 48000, channels: 1 }, audition: { generation: null } },
      ]),
    ).toThrow();
  });
});
