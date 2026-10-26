export class AppError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export type Fetcher = typeof fetch;
export const maxJsonBytes = 2 * 1024 * 1024;
export const maxWavBytes = 20 * 1024 * 1024;

// Limit decoded bytes as well as Content-Length (which may be absent or compressed).
export async function readBody(
  response: Response,
  limit: number,
  signal: AbortSignal,
): Promise<Buffer> {
  if (Number(response.headers.get('content-length')) > limit) {
    await response.body?.cancel();
    throw new AppError(502, 'サービスの応答がサイズ上限を超えました。');
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener('abort', cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new AppError(502, 'サービスの応答がサイズ上限を超えました。');
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks, size);
  } finally {
    signal.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
}

export async function remoteBytes(
  url: string,
  init: RequestInit,
  timeout: number,
  fetcher: Fetcher,
  limit: number,
): Promise<Buffer> {
  const signal = AbortSignal.timeout(timeout);
  try {
    const response = await fetcher(url, { ...init, redirect: 'error', signal });
    if (!response.ok) {
      await response.body?.cancel();
      throw new AppError(
        502,
        `サービスがエラーを返しました（HTTP ${response.status}）。モデル名・APIキー・利用上限を確認してください。`,
      );
    }
    return await readBody(response, limit, signal);
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(
      502,
      'サービスの応答を取得できませんでした。起動状態・モデル名・接続先を確認してください。処理が長い場合は軽いモデルもお試しください。',
    );
  }
}

export async function remoteJson(
  url: string,
  init: RequestInit,
  timeout: number,
  fetcher: Fetcher,
) {
  const bytes = await remoteBytes(url, init, timeout, fetcher, maxJsonBytes);
  try {
    return JSON.parse(bytes.toString('utf8')) as unknown;
  } catch {
    throw new AppError(502, 'サービスから有効なJSON応答を取得できませんでした。');
  }
}
