import { projectFixture } from './fixtures/project';
import { describe, expect, it } from 'vitest';
import {
  legacyDocuments,
  parseProject,
  projectStorageKey,
  readProject,
  readWorkspaceDocument,
  bindWorkspaceStorage,
  readWorkspaceProject,
  saveWorkspaceProject,
  serializeProject,
  validateProject,
  writeWorkspaceDocument,
  type ProjectStorage,
} from '../shared/project';
import { libraryStorageKey } from '../shared/voice-library';
import { scriptStorageKey, serializeScript } from '../shared/script';
import { scriptFixture } from './fixtures/script';

function storage() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
}
describe('project backups and atomic browser storage', () => {
  it('prevents another tab from overwriting a changed project and retains its own snapshot for backup', () => {
    const store = storage();
    const project = projectFixture();
    store.setItem(projectStorageKey, serializeProject(project));
    bindWorkspaceStorage(store);
    const external = { ...project, name: '別のタブからの保存' };
    store.setItem(projectStorageKey, serializeProject(external));
    expect(readWorkspaceProject(store)!.name).toBe(project.name);
    expect(() => saveWorkspaceProject(project, store)).toThrow('別のタブ');
    expect(() =>
      writeWorkspaceDocument(scriptStorageKey, serializeScript(scriptFixture().script), store),
    ).toThrow('別のタブ');
    expect(readProject(store)!.name).toBe(external.name);
    saveWorkspaceProject(project, store, true);
    expect(readWorkspaceProject(store)!.name).toBe(project.name);
  });
  it('round-trips independent casting and script snapshots with native tuning and reasons', () => {
    const project = projectFixture();
    const restored = parseProject(serializeProject(project));
    expect(restored).toEqual(project);
    expect(restored.documents.script!.lines[0].assignment!.comparison.reason).toBe(
      '聞き取りやすい',
    );
    expect(
      restored.documents.voiceLibrary.entries[0].evaluation.candidates[0].recipe,
    ).toMatchObject({ engine: 'AivisSpeech', tempoDynamicsScale: 0.72 });
    restored.documents.castingBoard.assignments[0].comparison.reason = '変更';
    expect(restored.documents.script!.lines[0].assignment!.comparison.reason).toBe(
      '聞き取りやすい',
    );
  });
  it('validates every nested document before replacing a project and strips unknown media/secrets', () => {
    const project = projectFixture();
    expect(
      parseProject(JSON.stringify({ ...project, image: 'secret-image', apiKey: 'secret-key' })),
    ).toEqual(project);
    for (const documents of [
      {
        ...project.documents,
        script: {
          ...project.documents.script,
          lines: [...project.documents.script!.lines, project.documents.script!.lines[0]],
        },
      },
      { ...project.documents, voiceLibrary: { format: 'other', version: 2, entries: [] } },
      {
        ...project.documents,
        castingBoard: {
          ...project.documents.castingBoard,
          assignments: [
            ...project.documents.castingBoard.assignments,
            project.documents.castingBoard.assignments[0],
          ],
        },
      },
      {
        ...project.documents,
        scriptLibrary: { format: 'voice-atlas-script-library', version: 2, entries: [] },
      },
    ])
      expect(() => validateProject({ ...project, documents })).toThrow();
    expect(() => parseProject(JSON.stringify({ ...project, version: 2 }))).toThrow();
  });
  it('isolates project saves from legacy data and changes just one project document', () => {
    const store = storage();
    const legacy = serializeScript(scriptFixture().script);
    store.setItem(scriptStorageKey, legacy);
    expect(readWorkspaceDocument(scriptStorageKey, store)).toBe(legacy);
    const project = projectFixture();
    store.setItem(projectStorageKey, serializeProject(project));
    const updated = { ...project.documents.script!, title: 'プロジェクト内だけ変更' };
    writeWorkspaceDocument(scriptStorageKey, serializeScript(updated), store);
    expect(JSON.parse(readWorkspaceDocument(scriptStorageKey, store)!).title).toBe(updated.title);
    expect(store.getItem(scriptStorageKey)).toBe(legacy);
    expect(readProject(store)!.documents.voiceLibrary).toEqual(project.documents.voiceLibrary);
  });
  it('leaves the whole stored project unchanged on validation or quota failure', () => {
    const store = storage();
    const before = serializeProject(projectFixture());
    store.setItem(projectStorageKey, before);
    expect(() => writeWorkspaceDocument(scriptStorageKey, '{"format":"bad"}', store)).toThrow();
    const full: ProjectStorage = {
      getItem: store.getItem,
      setItem: () => {
        throw new DOMException('full', 'QuotaExceededError');
      },
    };
    expect(() =>
      writeWorkspaceDocument(scriptStorageKey, serializeScript(scriptFixture().script), full),
    ).toThrow();
    expect(store.getItem(projectStorageKey)).toBe(before);
    expect(() => writeWorkspaceDocument('unrelated-key', '{}', store)).toThrow();
  });
  it('does not silently fall back to legacy data or erase corrupt saved documents', () => {
    const store = storage();
    store.setItem(scriptStorageKey, serializeScript(scriptFixture().script));
    store.setItem(projectStorageKey, '{broken');
    expect(() => readWorkspaceDocument(scriptStorageKey, store)).toThrow();
    expect(store.getItem(projectStorageKey)).toBe('{broken');
    const legacy = storage();
    legacy.setItem(libraryStorageKey, '{"format":"bad"}');
    expect(() => legacyDocuments(legacy)).toThrow();
    expect(legacy.getItem(libraryStorageKey)).toBe('{"format":"bad"}');
  });
  it('reads legacy library v1 and preserves historical removed identities', () => {
    const project = projectFixture();
    const library = project.documents.voiceLibrary;
    const old = { ...library, version: 1 };
    library.entries[0].evaluation.candidates[1].voice = {
      engine: 'VOICEVOX',
      voiceId: 'removed',
      name: '廃止話者',
      style: '通常',
    };
    const result = validateProject({
      ...project,
      documents: { ...project.documents, voiceLibrary: old },
    });
    expect(result.documents.voiceLibrary.version).toBe(2);
    expect(result.documents.voiceLibrary.entries[0].evaluation.candidates[1].voice).toMatchObject({
      voiceId: 'removed',
    });
  });
});
