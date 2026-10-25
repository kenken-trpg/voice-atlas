import { z } from 'zod';
import { validateProject, type VoiceProject } from './project';
import { scriptAudioKey } from './script';
import { libraryAuditionSchema, type LibraryAudition } from './library-comparison';
import { irodoriCandidates } from './irodori-candidates';
import {
  maxEntryAudioBytes,
  maxArchiveAudioEntries,
  maxProjectAudioBytes,
  validateSavedAudioBlob,
  validateScriptAudioAudition,
} from './script-audio-cache';

const magic = new TextEncoder().encode('VAARCH1\n');
export const maxArchiveBytes = 100 * 1024 * 1024;
export const maxArchiveHeaderBytes = 33 * 1024 * 1024;
export { maxArchiveAudioEntries } from './script-audio-cache';
export type ArchiveAudio = { lineId: string; key: string; blob: Blob; audition: LibraryAudition };
export type ArchiveIrodoriAudio = { sha256: string; blob: Blob };
export type ProjectArchive = {
  project: VoiceProject;
  audio: ArchiveAudio[];
  irodoriAudio: ArchiveIrodoriAudio[];
};
const irodoriSampleHashes = new Map<string, string>(
  irodoriCandidates.flatMap((voice) =>
    voice.samples.map((sample) => [sample.sha256, voice.id] as const),
  ),
);
const headerSchema = z
  .object({
    format: z.literal('voice-atlas-project-archive'),
    version: z.union([z.literal(1), z.literal(2)]),
    project: z.unknown(),
    audio: z
      .array(
        z
          .object({
            lineId: z.uuid(),
            key: z.string().max(16384),
            bytes: z.number().int().min(12).max(maxEntryAudioBytes),
            sha256: z.string().regex(/^[a-f0-9]{64}$/),
            audition: libraryAuditionSchema,
          })
          .strict(),
      )
      .max(maxArchiveAudioEntries),
    irodoriAudio: z
      .array(
        z
          .object({
            sha256: z.string().regex(/^[a-f0-9]{64}$/),
            bytes: z
              .number()
              .int()
              .min(12)
              .max(4 * 1024 * 1024),
          })
          .strict(),
      )
      .max(6)
      .optional(),
  })
  .strict();

export function projectArchiveLines(project: VoiceProject) {
  const lines = [
    ...(project.documents.script?.lines ?? []),
    ...project.documents.scriptLibrary.entries.flatMap((entry) => entry.script.lines),
  ];
  return [...new Map(lines.map((line) => [scriptAudioKey(line), line])).values()];
}
function boundAudio(
  project: VoiceProject,
  audio: { lineId: string; key: string; audition: LibraryAudition }[],
) {
  if (new Set(audio.map((item) => item.lineId)).size !== audio.length)
    throw new Error('アーカイブの音声行IDが重複しています。');
  const lines = new Map(projectArchiveLines(project).map((line) => [scriptAudioKey(line), line]));
  for (const item of audio) {
    const line = lines.get(item.key);
    if (!line || line.id !== item.lineId) throw new Error('音声と作品の台本条件が一致しません。');
    validateScriptAudioAudition(line, item.audition);
  }
}
async function hash(blob: Blob) {
  return Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())),
    (byte) => byte.toString(16).padStart(2, '0'),
  ).join('');
}

function boundIrodoriAudio(project: VoiceProject, audio: { sha256: string }[]) {
  const selected = new Set<string>(project.documents.irodoriCandidates);
  if (new Set(audio.map((item) => item.sha256)).size !== audio.length)
    throw new Error('Irodoriの候補音声が重複しています。');
  for (const item of audio) {
    const voiceId = irodoriSampleHashes.get(item.sha256);
    if (!voiceId || !selected.has(voiceId))
      throw new Error('Irodoriの候補音声と作品の選択が一致しません。');
  }
}

export async function createProjectArchive(
  project: VoiceProject,
  audio: ArchiveAudio[],
  signal?: AbortSignal,
  irodoriAudio: ArchiveIrodoriAudio[] = [],
) {
  signal?.throwIfAborted();
  const saved = validateProject(project);
  if (
    audio.length > maxArchiveAudioEntries ||
    audio.reduce((n, item) => n + item.blob.size, 0) > maxProjectAudioBytes
  )
    throw new Error('アーカイブの音声は620行・合計64MiBまでです。');
  boundAudio(saved, audio);
  boundIrodoriAudio(saved, irodoriAudio);
  const entries = [];
  for (const item of audio) {
    signal?.throwIfAborted();
    await validateSavedAudioBlob(item.blob);
    entries.push({
      lineId: item.lineId,
      key: item.key,
      bytes: item.blob.size,
      sha256: await hash(item.blob),
      audition: item.audition,
    });
  }
  const irodoriEntries = [];
  for (const item of irodoriAudio) {
    signal?.throwIfAborted();
    if (item.blob.size < 12 || item.blob.size > 4 * 1024 * 1024)
      throw new Error('Irodoriの候補音声は1件4MiBまでです。');
    await validateSavedAudioBlob(item.blob);
    if ((await hash(item.blob)) !== item.sha256)
      throw new Error('Irodoriの候補音声が検証記録と一致しません。');
    irodoriEntries.push({ sha256: item.sha256, bytes: item.blob.size });
  }
  const header = new TextEncoder().encode(
    JSON.stringify(
      headerSchema.parse({
        format: 'voice-atlas-project-archive',
        version: 2,
        project: saved,
        audio: entries,
        irodoriAudio: irodoriEntries,
      }),
    ),
  );
  if (header.length > maxArchiveHeaderBytes)
    throw new Error('アーカイブの設定情報は33MiBまでです。');
  const prefix = new Uint8Array(12);
  prefix.set(magic);
  new DataView(prefix.buffer).setUint32(8, header.length, true);
  signal?.throwIfAborted();
  const archive = new Blob(
    [prefix, header, ...audio.map((item) => item.blob), ...irodoriAudio.map((item) => item.blob)],
    {
      type: 'application/octet-stream',
    },
  );
  if (archive.size > maxArchiveBytes) throw new Error('作品アーカイブは100MiB以下にしてください。');
  return archive;
}

export async function parseProjectArchive(
  blob: Blob,
  signal?: AbortSignal,
): Promise<ProjectArchive> {
  signal?.throwIfAborted();
  if (blob.size < 12 || blob.size > maxArchiveBytes)
    throw new Error('作品アーカイブは100MiB以下にしてください。');
  const prefix = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
  if (magic.some((value, index) => prefix[index] !== value))
    throw new Error('作品アーカイブの形式を確認してください。');
  const size = new DataView(prefix.buffer).getUint32(8, true);
  if (size > maxArchiveHeaderBytes || size < 2 || size + 12 > blob.size)
    throw new Error('アーカイブの設定情報が不正です。');
  const header = headerSchema.parse(JSON.parse(await blob.slice(12, 12 + size).text()));
  if (header.version === 1 && header.irodoriAudio !== undefined)
    throw new Error('作品アーカイブの形式・版が一致しません。');
  if (header.version === 2 && header.irodoriAudio === undefined)
    throw new Error('作品アーカイブのIrodori音声情報がありません。');
  const project = validateProject(header.project);
  boundAudio(project, header.audio);
  boundIrodoriAudio(project, header.irodoriAudio ?? []);
  const bytes = header.audio.reduce((n, item) => n + item.bytes, 0);
  const irodoriBytes = (header.irodoriAudio ?? []).reduce((n, item) => n + item.bytes, 0);
  if (bytes > maxProjectAudioBytes || 12 + size + bytes + irodoriBytes !== blob.size)
    throw new Error('アーカイブの音声容量またはファイル長が不正です。');
  const audio: ArchiveAudio[] = [];
  let at = 12 + size;
  for (const item of header.audio) {
    signal?.throwIfAborted();
    const wav = blob.slice(at, at + item.bytes, 'audio/wav');
    await validateSavedAudioBlob(wav);
    if ((await hash(wav)) !== item.sha256) throw new Error('アーカイブの音声が破損しています。');
    audio.push({ lineId: item.lineId, key: item.key, audition: item.audition, blob: wav });
    at += item.bytes;
  }
  const irodoriAudio: ArchiveIrodoriAudio[] = [];
  for (const item of header.irodoriAudio ?? []) {
    signal?.throwIfAborted();
    const wav = blob.slice(at, at + item.bytes, 'audio/wav');
    await validateSavedAudioBlob(wav);
    if ((await hash(wav)) !== item.sha256) throw new Error('Irodoriの候補音声が破損しています。');
    irodoriAudio.push({ sha256: item.sha256, blob: wav });
    at += item.bytes;
  }
  signal?.throwIfAborted();
  return { project, audio, irodoriAudio };
}
