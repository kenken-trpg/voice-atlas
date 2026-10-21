import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const run = promisify(execFile);
const uuid = '11111111-1111-4111-8111-111111111111';
let server: Server, baseUrl: string, directory: string;
let requests = 0;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'voice-atlas-aivis-'));
  server = createServer((req, res) => {
    requests++;
    const path = new URL(req.url!, 'http://localhost').pathname;
    if (path === '/synthesis') {
      const wav = Buffer.alloc(44);
      wav.write('RIFF');
      wav.write('WAVE', 8);
      res.setHeader('Content-Type', 'audio/wav');
      res.end(wav);
      return;
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify(
        path === '/speakers'
          ? [{ name: '検証用話者', speaker_uuid: uuid, styles: [{ name: 'ノーマル', id: -123 }] }]
          : path === '/audio_query'
            ? { accent_phrases: [], outputSamplingRate: 44100, outputStereo: false }
            : 'test-version',
      ),
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  if (directory) await rm(directory, { recursive: true, force: true });
});
function cli(args: string[]) {
  return run(process.execPath, ['--import', 'tsx', 'server/aivis-probe.ts', ...args], {
    env: { ...process.env, AIVIS_BASE_URL: baseUrl },
    timeout: 10000,
  });
}
function args(output: string) {
  return [
    '--speaker-uuid',
    uuid,
    '--style',
    'ノーマル',
    '--text',
    '検証用のセリフです。',
    '--output',
    output,
  ];
}
describe('AivisSpeech probe command (mock engine only)', () => {
  it('lists voices without synthesizing or writing files', async () => {
    const before = requests;
    const { stdout } = await cli([]);
    expect(JSON.parse(stdout).speakers[0].styles[0].id).toBe(-123);
    expect(requests - before).toBe(1);
    expect(await readdir(directory)).toEqual([]);
  });
  it('writes audio and separate native evidence', async () => {
    const output = join(directory, 'sample.wav');
    await cli(args(output));
    expect((await readFile(output)).toString('ascii', 0, 4)).toBe('RIFF');
    const evidence = JSON.parse(await readFile(`${output}.json`, 'utf8'));
    expect(evidence).toMatchObject({
      format: 'voice-atlas-aivis-probe',
      version: 1,
      engine: 'AivisSpeech',
      engineVersion: 'test-version',
      speakerUuid: uuid,
      observedStyleId: -123,
      recipe: { engine: 'AivisSpeech', tempoDynamicsScale: 1, pitchScale: 0 },
    });
  });
  it('never overwrites existing audio or metadata and avoids generation', async () => {
    const output = join(directory, 'existing.wav');
    await writeFile(output, 'original audio');
    const before = requests;
    await expect(cli(args(output))).rejects.toThrow();
    expect(await readFile(output, 'utf8')).toBe('original audio');
    const another = join(directory, 'metadata.wav');
    await writeFile(`${another}.json`, 'original metadata');
    await expect(cli(args(another))).rejects.toThrow();
    expect(await readFile(`${another}.json`, 'utf8')).toBe('original metadata');
    await expect(readFile(another)).rejects.toThrow();
    expect(requests).toBe(before);
  });
  it('cleans up reserved output files when synthesis cannot resolve the target', async () => {
    const output = join(directory, 'failed.wav');
    const input = args(output);
    input[input.indexOf('--style') + 1] = '存在しないスタイル';
    await expect(cli(input)).rejects.toThrow();
    await expect(readFile(output)).rejects.toThrow();
    await expect(readFile(`${output}.json`)).rejects.toThrow();
  });
  it('rejects incomplete arguments without contacting the engine', async () => {
    const before = requests;
    await expect(cli(['--output', join(directory, 'invalid.wav')])).rejects.toThrow();
    expect(requests).toBe(before);
  });
});
