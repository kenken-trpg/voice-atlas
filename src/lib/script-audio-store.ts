import { z } from 'zod';
import { scriptAudioKey, scriptCandidate, type ScriptLine } from '../../shared/script';
import { libraryAuditionSchema, type LibraryAudition } from '../../shared/library-comparison';

export const audioDatabaseName = 'voice-atlas-script-audio-v1';
export const maxSavedAudioBytes = 128 * 1024 * 1024;
export const maxProjectAudioBytes = 64 * 1024 * 1024;
const maxEntryBytes = 20 * 1024 * 1024;
type Entry = {
  id: string;
  projectId: string;
  lineId: string;
  audioKey: string;
  blob: Blob;
  audition: LibraryAudition;
  storedAt: string;
};
type Size = { id: string; projectId: string; bytes: number };
export type AudioSave = { line: ScriptLine; blob: Blob; audition: LibraryAudition };
async function openDatabase() {
  if (typeof indexedDB === 'undefined')
    throw new Error('このブラウザでは音声の保存を利用できません。');
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(audioDatabaseName, 1);
    let rejected = false;
    request.onupgradeneeded = () => {
      for (const name of ['audio', 'sizes'])
        request.result
          .createObjectStore(name, { keyPath: 'id' })
          .createIndex('projectId', 'projectId');
    };
    request.onsuccess = () => {
      if (rejected) request.result.close();
      else resolve(request.result);
    };
    request.onerror = () => {
      rejected = true;
      reject(request.error);
    };
    request.onblocked = () => {
      rejected = true;
      reject(new Error('ほかのタブを閉じてから音声保存を再試行してください。'));
    };
  });
}
async function validBlob(blob: Blob) {
  if (!(blob instanceof Blob) || blob.size < 12 || blob.size > maxEntryBytes)
    throw new Error('保存できるWAVは1行20MiBまでです。');
  const head = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
  if (
    String.fromCharCode(...head.slice(0, 4)) !== 'RIFF' ||
    String.fromCharCode(...head.slice(8, 12)) !== 'WAVE'
  )
    throw new Error('WAV形式を確認できませんでした。');
}
function auditionFor(line: ScriptLine, raw: unknown) {
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
const entryId = (projectId: string, lineId: string) => JSON.stringify([projectId, lineId]);
export async function saveScriptAudio(projectId: string, sources: AudioSave[]) {
  z.uuid().parse(projectId);
  if (
    !sources.length ||
    sources.length > 20 ||
    new Set(sources.map((s) => s.line.id)).size !== sources.length
  )
    throw new Error('保存する台本音声が不正です。');
  const entries: Entry[] = [];
  for (const source of sources) {
    z.uuid().parse(source.line.id);
    await validBlob(source.blob);
    entries.push({
      id: entryId(projectId, source.line.id),
      projectId,
      lineId: source.line.id,
      audioKey: scriptAudioKey(source.line),
      blob: source.blob,
      audition: auditionFor(source.line, source.audition),
      storedAt: new Date().toISOString(),
    });
  }
  const db = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(['audio', 'sizes'], 'readwrite');
      let failure: unknown;
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(failure ?? tx.error ?? new Error('音声保存を中止しました。'));
      tx.onerror = () => {
        failure ??= tx.error;
      };
      const request = tx.objectStore('sizes').getAll();
      request.onsuccess = () => {
        try {
          const replaced = new Set(entries.map((e) => e.id));
          const sizes: Size[] = (request.result as Size[]).filter((s) => !replaced.has(s.id));
          sizes.push(...entries.map((e) => ({ id: e.id, projectId, bytes: e.blob.size })));
          if (
            sizes.length > 1000 ||
            sizes.some((s) => !Number.isSafeInteger(s.bytes) || s.bytes < 0) ||
            sizes.reduce((n, s) => n + s.bytes, 0) > maxSavedAudioBytes ||
            sizes.filter((s) => s.projectId === projectId).reduce((n, s) => n + s.bytes, 0) >
              maxProjectAudioBytes
          )
            throw new Error(
              '保存音声の容量上限です。この作品は64MiB、全作品で128MiBまでです。不要な保存音声を削除してください。',
            );
          for (const entry of entries) {
            tx.objectStore('audio').put(entry);
            tx.objectStore('sizes').put({ id: entry.id, projectId, bytes: entry.blob.size });
          }
        } catch (cause) {
          failure = cause;
          tx.abort();
        }
      };
    });
  } finally {
    db.close();
  }
}
export async function loadScriptAudio(projectId: string, lines: ScriptLine[]) {
  z.uuid().parse(projectId);
  const db = await openDatabase();
  let raw: unknown[];
  try {
    raw = await new Promise<unknown[]>((resolve, reject) => {
      const tx = db.transaction('audio', 'readonly'),
        found: unknown[] = [];
      tx.oncomplete = () => resolve(found);
      tx.onabort = () => reject(tx.error);
      tx.onerror = () => reject(tx.error);
      for (const line of lines) {
        const request = tx.objectStore('audio').get(entryId(projectId, line.id));
        request.onsuccess = () => {
          if (request.result) found.push(request.result);
        };
      }
    });
  } finally {
    db.close();
  }
  const result: { lineId: string; key: string; blob: Blob; audition: LibraryAudition }[] = [];
  for (const item of raw) {
    const entry = item as Entry;
    const line = lines.find((l) => l.id === entry.lineId);
    if (
      !line ||
      entry.projectId !== projectId ||
      entry.id !== entryId(projectId, line.id) ||
      entry.audioKey !== scriptAudioKey(line)
    )
      continue;
    try {
      await validBlob(entry.blob);
      result.push({
        lineId: line.id,
        key: entry.audioKey,
        blob: entry.blob,
        audition: auditionFor(line, entry.audition),
      });
    } catch {
      /* Corrupt or incompatible cache entries never replace current audio. */
    }
  }
  return result;
}
export async function deleteProjectAudio(projectId: string | null) {
  if (projectId !== null) z.uuid().parse(projectId);
  const db = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(['audio', 'sizes'], 'readwrite');
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error);
      tx.onerror = () => reject(tx.error);
      if (projectId === null) {
        tx.objectStore('audio').clear();
        tx.objectStore('sizes').clear();
        return;
      }
      const request = tx
        .objectStore('sizes')
        .index('projectId')
        .openCursor(IDBKeyRange.only(projectId));
      request.onsuccess = () => {
        const cursor = request.result;
        if (cursor) {
          tx.objectStore('audio').delete(cursor.primaryKey);
          cursor.delete();
          cursor.continue();
        }
      };
    });
  } finally {
    db.close();
  }
}
