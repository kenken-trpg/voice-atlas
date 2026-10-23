import { describe, expect, it } from 'vitest';
import {
  createProjectArchive,
  parseProjectArchive,
  projectArchiveLines,
  maxArchiveBytes,
  maxArchiveHeaderBytes,
  type ArchiveAudio,
} from '../shared/project-archive';
import { parseProject, serializeProject } from '../shared/project';
import { scriptAudioKey } from '../shared/script';
import { makeScriptLibraryEntry } from '../shared/script-library';
import { projectFixture } from './fixtures/project';
import { pcmWav } from './fixtures/wav';

function fixture() {
  const project = projectFixture();
  const line = project.documents.script!.lines[0];
  line.spokenText = 'ようこそ、ほしよみのとうへ。';
  line.readingSource = 'manual';
  const audio: ArchiveAudio[] = [
    {
      lineId: line.id,
      key: scriptAudioKey(line),
      blob: new Blob([pcmWav([123, -456])]),
      audition: {
        generation: {
          engine: 'AivisSpeech',
          engineVersion: 'archive-test',
          checkedAt: project.createdAt,
        },
      },
    },
  ];
  return { project, audio };
}
async function unpack(blob: Blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const size = new DataView(bytes.buffer).getUint32(8, true);
  return {
    header: JSON.parse(new TextDecoder().decode(bytes.subarray(12, 12 + size))),
    tail: bytes.subarray(12 + size),
  };
}
function pack(header: unknown, tail: Uint8Array<ArrayBuffer>) {
  const json = new TextEncoder().encode(JSON.stringify(header));
  const prefix = new Uint8Array(12);
  prefix.set(new TextEncoder().encode('VAARCH1\n'));
  new DataView(prefix.buffer).setUint32(8, json.length, true);
  return new Blob([prefix, json, tail]);
}

describe('portable project audio archive', () => {
  it('round-trips settings, readings, saved scripts, audio bytes and fresh generation provenance', async () => {
    const { project, audio } = fixture();
    project.documents.pronunciations = [
      { id: crypto.randomUUID(), term: '星詠み', reading: 'ほしよみ' },
    ];
    project.documents.scriptLibrary.entries = [
      makeScriptLibraryEntry(project.documents.script!, '物語', '導入'),
    ];
    const blob = await createProjectArchive(project, audio);
    const result = await parseProjectArchive(blob);
    expect(result.project).toEqual(project);
    expect(result.audio[0].audition).toEqual(audio[0].audition);
    expect(result.audio[0].key).toBe(audio[0].key);
    expect(await result.audio[0].blob.arrayBuffer()).toEqual(await audio[0].blob.arrayBuffer());
    expect(projectArchiveLines(project)).toHaveLength(2);
    expect(parseProject(serializeProject(project))).toEqual(project);
  });
  it('allows no audio and strips fields outside the project format', async () => {
    const { project } = fixture();
    const blob = await createProjectArchive(
      { ...project, apiKey: 'synthetic-do-not-copy' } as typeof project,
      [],
    );
    const result = await parseProjectArchive(blob);
    expect(result.audio).toEqual([]);
    expect(result.project).toEqual(project);
    expect(await blob.text()).not.toContain('synthetic-do-not-copy');
  });
  it('binds a cached condition to a saved script even when the editing script has changed the same row ID', async () => {
    const { project, audio } = fixture();
    project.documents.scriptLibrary.entries = [
      makeScriptLibraryEntry(structuredClone(project.documents.script!), '物語', '導入'),
    ];
    project.documents.script!.lines[0].spokenText = '編集中の別の読み';
    expect(projectArchiveLines(project)).toHaveLength(3);
    const result = await parseProjectArchive(await createProjectArchive(project, audio));
    expect(result.audio[0].key).toBe(audio[0].key);
  });
  it('rejects duplicate, unrelated, changed and mismatched-generation audio bindings', async () => {
    const { project, audio } = fixture();
    await expect(createProjectArchive(project, [audio[0], audio[0]])).rejects.toThrow('重複');
    await expect(
      createProjectArchive(project, [{ ...audio[0], lineId: crypto.randomUUID() }]),
    ).rejects.toThrow('一致');
    await expect(
      createProjectArchive(project, [{ ...audio[0], key: 'different' }]),
    ).rejects.toThrow('一致');
    await expect(
      createProjectArchive(project, [
        {
          ...audio[0],
          audition: {
            generation: { engine: 'VOICEVOX', engineVersion: null, checkedAt: project.createdAt },
          },
        },
      ]),
    ).rejects.toThrow('話者');
  });
  it('detects a modified WAV payload, truncation, trailing data and invalid WAV signatures', async () => {
    const { project, audio } = fixture();
    const blob = await createProjectArchive(project, audio);
    const { header, tail } = await unpack(blob);
    tail[tail.length - 1] ^= 1;
    await expect(parseProjectArchive(pack(header, tail))).rejects.toThrow('破損');
    await expect(parseProjectArchive(blob.slice(0, blob.size - 1))).rejects.toThrow('ファイル長');
    await expect(parseProjectArchive(new Blob([blob, 'extra']))).rejects.toThrow('ファイル長');
    await expect(
      createProjectArchive(project, [{ ...audio[0], blob: new Blob(['invalid header!']) }]),
    ).rejects.toThrow('WAV形式');
  });
  it('rejects unsupported versions, oversized declarations, invalid metadata and corrupt settings', async () => {
    const { project, audio } = fixture();
    const { header, tail } = await unpack(await createProjectArchive(project, audio));
    for (const change of [
      (h: typeof header) => {
        h.version = 2;
      },
      (h: typeof header) => {
        h.project.documents.script.lines.push(h.project.documents.script.lines[0]);
      },
      (h: typeof header) => {
        h.audio[0].bytes = 21 * 1024 ** 2;
      },
      (h: typeof header) => {
        h.audio[0].sha256 = 'invalid';
      },
      (h: typeof header) => {
        h.audio[0].audition.generation.engine = 'VOICEVOX';
      },
      (h: typeof header) => {
        h.audio = Array(621).fill(h.audio[0]);
      },
    ]) {
      const copy = structuredClone(header);
      change(copy);
      await expect(parseProjectArchive(pack(copy, tail))).rejects.toThrow();
    }
    const prefix = new Uint8Array(12);
    prefix.set(new TextEncoder().encode('VAARCH1\n'));
    new DataView(prefix.buffer).setUint32(8, maxArchiveHeaderBytes + 1, true);
    await expect(parseProjectArchive(new Blob([prefix]))).rejects.toThrow('設定情報');
    await expect(parseProjectArchive(new Blob(['not-an-archive']))).rejects.toThrow('形式');
    const oversized = new Blob();
    Object.defineProperty(oversized, 'size', { value: maxArchiveBytes + 1 });
    await expect(parseProjectArchive(oversized)).rejects.toThrow('100MiB');
  });
  it('checks total source capacity before reading and honors cancellation', async () => {
    const { project, audio } = fixture();
    Object.defineProperty(audio[0].blob, 'size', { value: 65 * 1024 ** 2 });
    await expect(createProjectArchive(project, audio)).rejects.toThrow('合計64MiB');
    const request = new AbortController();
    request.abort();
    await expect(createProjectArchive(project, [], request.signal)).rejects.toThrow();
    await expect(parseProjectArchive(new Blob(), request.signal)).rejects.toThrow();
  });
});
