import type { VoiceScript } from '../../shared/script';
import {
  checkScriptAudioInput,
  type ScriptAudioSource,
  type ScriptAudioResult,
} from '../../shared/script-audio-join';

export async function prepareScriptAudio(
  script: VoiceScript,
  sources: ScriptAudioSource[],
  signal: AbortSignal,
): Promise<ScriptAudioResult> {
  signal.throwIfAborted();
  checkScriptAudioInput(sources);
  const worker = new Worker(new URL('./script-audio-worker.ts', import.meta.url), {
    type: 'module',
  });
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      worker.terminate();
      signal.removeEventListener('abort', abort);
    };
    const abort = () => {
      cleanup();
      reject(signal.reason);
    };
    signal.addEventListener('abort', abort, { once: true });
    worker.onmessage = (
      event: MessageEvent<{ ok: true; result: ScriptAudioResult } | { ok: false; error: string }>,
    ) => {
      cleanup();
      if (event.data.ok) resolve(event.data.result);
      else reject(new Error(event.data.error));
    };
    const failed = () => {
      cleanup();
      reject(new Error('音声の結合処理を起動・実行できませんでした。再試行してください。'));
    };
    worker.onerror = (event) => {
      event.preventDefault();
      failed();
    };
    worker.onmessageerror = failed;
    try {
      worker.postMessage({ script, sources });
    } catch (cause) {
      cleanup();
      reject(cause);
    }
  });
}
