import { scriptSchema, type VoiceScript } from './script';
import { makeScriptAudioManifest } from './script-audio';
import { type LibraryAudition } from './library-comparison';
import {
  checkJoinedFrames,
  encodeJoinedWav,
  joinedSampleRate,
  maxJoinInputBytes,
  normalizePcm,
  outputFrames,
  readPcmWav,
} from './wav';

export type ScriptAudioSource = { blob: Blob; audition: LibraryAudition };
export type ScriptAudioResult = {
  bytes: Uint8Array<ArrayBuffer>;
  manifest: ReturnType<typeof makeScriptAudioManifest>;
};

export function checkScriptAudioInput(sources: ScriptAudioSource[]) {
  if (!sources.length || sources.length > 20)
    throw new Error('結合する台本は1〜20行にしてください。');
  if (sources.reduce((bytes, source) => bytes + source.blob.size, 0) > maxJoinInputBytes)
    throw new Error('結合元の音声は合計64MiBまでです。台本を分けるか、行別WAVを保存してください。');
}

// Called inside a disposable worker; original Blobs and row audio are never transferred away.
export async function joinScriptAudio(
  script: VoiceScript,
  sources: ScriptAudioSource[],
): Promise<ScriptAudioResult> {
  checkScriptAudioInput(sources);
  const saved = scriptSchema.parse(script);
  if (saved.lines.length !== sources.length) throw new Error('全行の設定と音声を揃えてください。');
  const parts: Int16Array[] = [],
    inputs: Parameters<typeof makeScriptAudioManifest>[1] = [];
  const gapFrames = Math.round((saved.gapMs * joinedSampleRate) / 1000);
  let totalFrames = gapFrames * (sources.length - 1);
  for (const source of sources) {
    const wav = readPcmWav(new Uint8Array(await source.blob.arrayBuffer()));
    totalFrames += outputFrames(wav);
    checkJoinedFrames(totalFrames);
    const samples = normalizePcm(wav);
    parts.push(samples);
    inputs.push({
      frames: samples.length,
      source: { sampleRate: wav.sampleRate, channels: wav.channels },
      audition: source.audition,
    });
  }
  return {
    bytes: encodeJoinedWav(parts, gapFrames),
    manifest: makeScriptAudioManifest(saved, inputs),
  };
}
