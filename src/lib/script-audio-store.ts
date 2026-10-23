import { z } from 'zod';
import { savedAudioChangedEvent } from './script-audio-events';
import { scriptAudioKey, type ScriptLine } from '../../shared/script';
import { type LibraryAudition } from '../../shared/library-comparison';
import {
  maxSavedAudioBytes,
  maxSavedAudioEntries,
  maxArchiveAudioEntries,
  maxProjectAudioBytes,
  validateSavedAudioBlob as validBlob,
  validateScriptAudioAudition as auditionFor,
} from '../../shared/script-audio-cache';
export { maxSavedAudioBytes, maxProjectAudioBytes } from '../../shared/script-audio-cache';

export const audioDatabaseName = 'voice-atlas-script-audio-v1';
export class SavedAudioChangedError extends Error {
  constructor() {
    super('保存音声量が変わりました。内容を確認してからもう一度削除してください。');
  }
}
type Entry = {
  id: string;
  projectId: string;
  lineId: string;
  audioKey: string;
  blob: Blob;
  audition: LibraryAudition;
  storedAt: string;
};
export type SavedAudioItem = {
  id: string;
  lineId: string;
  bytes: number;
  revision?: string;
};
type Size = { id: string; projectId: string; bytes: number; revision?: string };
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
const entryId = (projectId: string, lineId: string) => JSON.stringify([projectId, lineId]);
function notifySavedAudioChanged() {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(savedAudioChangedEvent));
}
async function readSavedAudioSizes() {
  const db = await openDatabase();
  try {
    return await new Promise<Size[]>((resolve, reject) => {
      const tx = db.transaction('sizes', 'readonly');
      const request = tx.objectStore('sizes').getAll();
      tx.oncomplete = () => {
        const sizes = request.result as Size[];
        if (
          !Array.isArray(sizes) ||
          sizes.some(
            (item) =>
              !Number.isSafeInteger(item.bytes) ||
              item.bytes < 0 ||
              typeof item.projectId !== 'string' ||
              typeof item.id !== 'string' ||
              (item.revision !== undefined && typeof item.revision !== 'string'),
          )
        ) {
          reject(new Error('保存音声の容量情報を確認できません。'));
          return;
        }
        resolve(sizes);
      };
      tx.onabort = () => reject(tx.error);
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}
export async function readSavedAudioUsage() {
  const sizes = await readSavedAudioSizes();
  return { bytes: sizes.reduce((sum, item) => sum + item.bytes, 0), entries: sizes.length };
}
export async function readSavedAudioByProject() {
  const sizes = await readSavedAudioSizes();
  const usage = new Map<string, { bytes: number; entries: number }>();
  for (const item of sizes) {
    const current = usage.get(item.projectId) ?? { bytes: 0, entries: 0 };
    usage.set(item.projectId, { bytes: current.bytes + item.bytes, entries: current.entries + 1 });
  }
  return usage;
}
export async function readProjectAudioItems(projectId: string): Promise<SavedAudioItem[]> {
  z.uuid().parse(projectId);
  const sizes = await readSavedAudioSizes();
  return sizes
    .filter((item) => item.projectId === projectId)
    .map((item) => {
      let lineId: string;
      try {
        const key = JSON.parse(item.id) as unknown;
        if (!Array.isArray(key) || key.length !== 2 || key[0] !== projectId)
          throw new Error('invalid key');
        lineId = z.uuid().parse(key[1]);
      } catch {
        // Legacy or damaged metadata remains removable without loading the WAV.
        lineId = '';
      }
      return { id: item.id, lineId, bytes: item.bytes, revision: item.revision };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}
export async function saveScriptAudio(projectId: string, sources: AudioSave[]) {
  return saveAudio(projectId, sources, 20);
}
export async function saveProjectArchiveAudio(projectId: string, sources: AudioSave[]) {
  return saveAudio(projectId, sources, maxArchiveAudioEntries);
}
async function saveAudio(projectId: string, sources: AudioSave[], limit: number) {
  z.uuid().parse(projectId);
  if (
    !sources.length ||
    sources.length > limit ||
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
          const nextSizes = entries.map((e) => ({
            id: e.id,
            projectId,
            bytes: e.blob.size,
            revision: crypto.randomUUID(),
          }));
          sizes.push(...nextSizes);
          if (
            sizes.length > maxSavedAudioEntries ||
            sizes.some((s) => !Number.isSafeInteger(s.bytes) || s.bytes < 0) ||
            sizes.reduce((n, s) => n + s.bytes, 0) > maxSavedAudioBytes ||
            sizes.filter((s) => s.projectId === projectId).reduce((n, s) => n + s.bytes, 0) >
              maxProjectAudioBytes
          )
            throw new Error(
              '保存音声の容量上限です。この作品は64MiB、全作品で128MiB・1000行までです。不要な保存音声を削除してください。',
            );
          for (const [index, entry] of entries.entries()) {
            tx.objectStore('audio').put(entry);
            tx.objectStore('sizes').put(nextSizes[index]);
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
  notifySavedAudioChanged();
}
export async function deleteSelectedProjectAudio(
  projectId: string,
  expected: SavedAudioItem[],
  selectedIds: string[],
) {
  z.uuid().parse(projectId);
  const selected = new Set(selectedIds);
  if (
    !selected.size ||
    selected.size !== selectedIds.length ||
    selectedIds.some((id) => !expected.some((item) => item.id === id))
  )
    throw new Error('削除する保存音声を選択してください。');
  const db = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(['audio', 'sizes'], 'readwrite');
      let failure: unknown;
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(failure ?? tx.error);
      tx.onerror = () => {
        failure ??= tx.error;
      };
      const request = tx
        .objectStore('sizes')
        .index('projectId')
        .getAll(IDBKeyRange.only(projectId));
      request.onsuccess = () => {
        try {
          const actual = request.result as Size[];
          if (
            actual.length !== expected.length ||
            actual.some((item) => {
              const old = expected.find((candidate) => candidate.id === item.id);
              return !old || old.bytes !== item.bytes || old.revision !== item.revision;
            })
          )
            throw new SavedAudioChangedError();
          for (const id of selected) {
            tx.objectStore('audio').delete(id);
            tx.objectStore('sizes').delete(id);
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
  notifySavedAudioChanged();
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
      for (const line of new Map(lines.map((line) => [line.id, line])).values()) {
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
    const line = lines.find((l) => l.id === entry.lineId && scriptAudioKey(l) === entry.audioKey);
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
export async function deleteProjectAudio(
  projectId: string | null,
  expected?: { bytes: number; entries: number },
) {
  if (projectId !== null) z.uuid().parse(projectId);
  if (projectId === null && expected)
    throw new Error('全作品の削除には個別作品の確認値を指定できません。');
  const db = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(['audio', 'sizes'], 'readwrite');
      let failure: unknown;
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(failure ?? tx.error);
      tx.onerror = () => {
        failure ??= tx.error;
      };
      if (projectId === null) {
        tx.objectStore('audio').clear();
        tx.objectStore('sizes').clear();
        return;
      }
      const request = tx
        .objectStore('sizes')
        .index('projectId')
        .getAll(IDBKeyRange.only(projectId));
      request.onsuccess = () => {
        try {
          const sizes = request.result as Size[];
          if (
            expected &&
            (sizes.length !== expected.entries ||
              sizes.reduce((sum, item) => sum + item.bytes, 0) !== expected.bytes)
          )
            throw new SavedAudioChangedError();
          for (const item of sizes) {
            tx.objectStore('audio').delete(item.id);
            tx.objectStore('sizes').delete(item.id);
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
  notifySavedAudioChanged();
}
