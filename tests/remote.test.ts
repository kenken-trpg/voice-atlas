import { describe, expect, it, vi } from 'vitest';
import { remoteBytes, remoteJson, maxJsonBytes } from '../server/remote';

describe('bounded service responses', () => {
  it('rejects an oversized Content-Length without reading the body', async () => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({ cancel }), {
      headers: { 'Content-Length': String(maxJsonBytes + 1) },
    });
    await expect(
      remoteJson('http://localhost/', {}, 1000, async () => response),
    ).rejects.toMatchObject({ status: 502 });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it.each([undefined, '1'])(
    'counts streamed bytes even when Content-Length is %s',
    async (length) => {
      const cancel = vi.fn();
      const response = new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(4));
            controller.enqueue(new Uint8Array(5));
          },
          cancel,
        }),
        { headers: length ? { 'Content-Length': length } : {} },
      );
      await expect(
        remoteBytes('http://localhost/', {}, 1000, async () => response, 8),
      ).rejects.toThrow('サイズ上限');
      expect(cancel).toHaveBeenCalledOnce();
    },
  );

  it('accepts an exact byte limit and prevents redirects', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('12345678'));
    expect((await remoteBytes('http://localhost/', {}, 1000, fetcher, 8)).toString()).toBe(
      '12345678',
    );
    expect(fetcher.mock.calls[0][1]).toMatchObject({
      redirect: 'error',
      signal: expect.any(AbortSignal),
    });
  });

  it('cancels a stalled response body when its deadline expires', async () => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({ cancel }));
    await expect(
      remoteBytes('http://localhost/', {}, 20, async () => response, 8),
    ).rejects.toMatchObject({ status: 502 });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('masks body read failures and provider errors', async () => {
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.error(new Error('secret provider payload'));
        },
      }),
    );
    await expect(
      remoteBytes('http://localhost/', {}, 1000, async () => response, 8),
    ).rejects.toThrow('サービスの応答を取得');
    await expect(
      remoteJson(
        'http://localhost/',
        {},
        1000,
        async () => new Response('secret', { status: 401 }),
      ),
    ).rejects.toThrow('HTTP 401');
    await expect(
      remoteJson('http://localhost/', {}, 1000, async () => new Response('secret')),
    ).rejects.toThrow('有効なJSON');
  });
});
