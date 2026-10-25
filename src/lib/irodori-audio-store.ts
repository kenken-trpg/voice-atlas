import { irodoriCandidates } from '../../shared/irodori-candidates';

const databaseName = 'voice-atlas-irodori-samples-v1';
const storeName = 'samples';
const samples: { file: string; sha256: string }[] = (
  irodoriCandidates as readonly { samples: readonly { file: string; sha256: string }[] }[]
).flatMap((voice) => [...voice.samples]);

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(storeName);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('音声の保存先を開けませんでした。'));
  });
}

export async function readIrodoriAudio(): Promise<Record<string, Blob>> {
  const db = await openDatabase();
  try {
    const transaction = db.transaction(storeName, 'readonly');
    const values = await Promise.all(
      samples.map(
        (sample) =>
          new Promise<[string, Blob | undefined]>((resolve, reject) => {
            const request = transaction.objectStore(storeName).get(sample.sha256);
            request.onsuccess = () => resolve([sample.sha256, request.result as Blob | undefined]);
            request.onerror = () => reject(request.error);
          }),
      ),
    );
    return Object.fromEntries(
      values.filter((entry): entry is [string, Blob] => entry[1] instanceof Blob),
    );
  } finally {
    db.close();
  }
}

export async function saveIrodoriAudio(files: File[]): Promise<number> {
  const known = new Map(samples.map((sample) => [sample.file, sample]));
  const accepted: [string, Blob][] = [];
  for (const file of files) {
    const sample = known.get(file.name);
    if (!sample) continue;
    if (file.size > 4 * 1024 * 1024) throw new Error(`${file.name}が大きすぎます。`);
    const bytes = await file.arrayBuffer();
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)))
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');
    if (hash !== sample.sha256) throw new Error(`${file.name}の内容が検証記録と一致しません。`);
    accepted.push([sample.sha256, new Blob([bytes], { type: 'audio/wav' })]);
  }
  if (!accepted.length) throw new Error('対象のWAVが見つかりませんでした。');
  const db = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(storeName, 'readwrite');
      const store = transaction.objectStore(storeName);
      for (const [key, blob] of accepted) store.put(blob, key);
      transaction.oncomplete = () => resolve();
      transaction.onabort = () =>
        reject(transaction.error ?? new Error('音声を保存できませんでした。'));
      transaction.onerror = () =>
        reject(transaction.error ?? new Error('音声を保存できませんでした。'));
    });
  } finally {
    db.close();
  }
  return accepted.length;
}

export async function deleteIrodoriAudio(hashes: string[]): Promise<void> {
  if (!hashes.length) return;
  const db = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(storeName, 'readwrite');
      const store = transaction.objectStore(storeName);
      for (const hash of hashes) store.delete(hash);
      transaction.oncomplete = () => resolve();
      transaction.onabort = () =>
        reject(transaction.error ?? new Error('音声を削除できませんでした。'));
      transaction.onerror = () =>
        reject(transaction.error ?? new Error('音声を削除できませんでした。'));
    });
  } finally {
    db.close();
  }
}
