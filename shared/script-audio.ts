import {
  parseScript,
  serializeScript,
  scriptCandidate,
  scriptSpokenText,
  type VoiceScript,
} from './script';
import { libraryAuditionSchema, type LibraryAudition } from './library-comparison';
import { joinedSampleRate, checkJoinedFrames } from './wav';

export type JoinedLine = {
  frames: number;
  source: { sampleRate: number; channels: number };
  audition: LibraryAudition;
};
export function makeScriptAudioManifest(script: VoiceScript, inputs: JoinedLine[]) {
  const saved = parseScript(serializeScript(script));
  if (
    !inputs.length ||
    inputs.length !== saved.lines.length ||
    saved.lines.some((line) => !line.assignment || !line.text.trim())
  )
    throw new Error('全行の設定と音声を揃えてください。');
  const gapFrames = Math.round((saved.gapMs * joinedSampleRate) / 1000);
  let cursor = 0;
  const lines = inputs.map((input, index) => {
    if (
      !Number.isSafeInteger(input.frames) ||
      input.frames < 1 ||
      !Number.isInteger(input.source.sampleRate) ||
      input.source.sampleRate < 8000 ||
      input.source.sampleRate > 48000 ||
      ![1, 2].includes(input.source.channels)
    )
      throw new Error('音声の形式が不正です。');
    const audition = libraryAuditionSchema.parse(input.audition),
      voice = scriptCandidate(saved.lines[index])!.voice;
    if (
      (audition.generation && audition.generation.engine !== voice.engine) ||
      (audition.modelInfo &&
        (voice.engine !== 'AivisSpeech' ||
          audition.modelInfo.speakerUuid.toLowerCase() !== voice.speakerUuid.toLowerCase() ||
          audition.modelInfo.styleName !== voice.style))
    )
      throw new Error('今回の音声の生成情報と話者が一致しません。');
    const startFrame = cursor,
      endFrame = cursor + input.frames;
    cursor = endFrame + (index < inputs.length - 1 ? gapFrames : 0);
    return {
      lineId: saved.lines[index].id,
      spokenText: scriptSpokenText(saved.lines[index]),
      startFrame,
      endFrame,
      startMs: (startFrame * 1000) / joinedSampleRate,
      endMs: (endFrame * 1000) / joinedSampleRate,
      source: { ...input.source, bitsPerSample: 16 },
      audition,
    };
  });
  checkJoinedFrames(cursor);
  const id = crypto.randomUUID();
  return {
    format: 'voice-atlas-script-audio' as const,
    version: 1 as const,
    id,
    createdAt: new Date().toISOString(),
    wavFileName: `voice-atlas-script-${id}.wav`,
    gapMs: saved.gapMs,
    output: {
      sampleRate: joinedSampleRate,
      channels: 1,
      bitsPerSample: 16,
      frames: cursor,
      durationMs: (cursor * 1000) / joinedSampleRate,
    },
    script: saved,
    lines,
  };
}
