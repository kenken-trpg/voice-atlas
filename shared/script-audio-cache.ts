import { scriptCandidate, type ScriptLine } from './script';
import { libraryAuditionSchema } from './library-comparison';

export const maxSavedAudioBytes = 128 * 1024 * 1024;
export const maxProjectAudioBytes = 64 * 1024 * 1024;
export const maxEntryAudioBytes = 20 * 1024 * 1024;
export const maxArchiveAudioEntries = 620;

export async function validateSavedAudioBlob(blob: Blob) {
  if (!(blob instanceof Blob) || blob.size < 12 || blob.size > maxEntryAudioBytes)
    throw new Error('保存できるWAVは1行20MiBまでです。');
  const head = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
  if (
    String.fromCharCode(...head.slice(0, 4)) !== 'RIFF' ||
    String.fromCharCode(...head.slice(8, 12)) !== 'WAVE'
  )
    throw new Error('WAV形式を確認できませんでした。');
}

export function validateScriptAudioAudition(line: ScriptLine, raw: unknown) {
  const audition = libraryAuditionSchema.parse(raw),
    voice = scriptCandidate(line)?.voice;
  if (
    !voice ||
    (audition.generation && audition.generation.engine !== voice.engine) ||
    (audition.modelInfo &&
      (voice.engine !== 'AivisSpeech' ||
        audition.modelInfo.speakerUuid.toLowerCase() !== voice.speakerUuid.toLowerCase() ||
        audition.modelInfo.styleName !== voice.style))
  )
    throw new Error('保存音声と生成情報の話者が一致しません。');
  return audition;
}
