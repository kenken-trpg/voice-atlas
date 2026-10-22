import { describe, expect, it } from 'vitest';
import { projectFixture } from './fixtures/project';
import {
  bindWorkspaceStorage,
  makeEmptyProject,
  parseProjectLibrary,
  projectLibraryStorageKey,
  projectStorageKey,
  readProject,
  readProjectLibrary,
  serializeProject,
  updateProjectLibrary,
  writeWorkspaceDocument,
} from '../shared/project';
import { scriptStorageKey, serializeScript } from '../shared/script';
function store() {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, text: string) => {
      data.set(key, text);
    },
  };
}
describe('multiple project library', () => {
  it('adopts a saved single project without altering legacy data and isolates edits and duplicates', () => {
    const storage = store(),
      first = projectFixture(),
      second = makeEmptyProject('別の作品');
    const legacy = serializeProject(first);
    storage.setItem(projectStorageKey, legacy);
    bindWorkspaceStorage(storage);
    updateProjectLibrary(storage, { type: 'open', project: second });
    expect(readProjectLibrary(storage).projects).toHaveLength(2);
    expect(readProject(storage)!.documents.script).toBeNull();
    expect(storage.getItem(projectStorageKey)).toBe(legacy);
    const changed = { ...second, name: '編集した作品' };
    updateProjectLibrary(storage, { type: 'select', id: first.id }, changed);
    expect(readProject(storage)!.documents.script!.lines).toHaveLength(2);
    writeWorkspaceDocument(
      scriptStorageKey,
      serializeScript({ ...first.documents.script!, title: '作品Aだけ変更' }),
      storage,
    );
    expect(readProjectLibrary(storage).projects.find((p) => p.id === second.id)!.name).toBe(
      changed.name,
    );
    const copy = { ...structuredClone(first), id: crypto.randomUUID(), name: 'コピー' };
    updateProjectLibrary(storage, { type: 'open', project: copy });
    updateProjectLibrary(storage, { type: 'delete', id: first.id });
    expect(readProject(storage)!.id).toBe(copy.id);
    expect(readProjectLibrary(storage).projects).toHaveLength(2);
  });
  it('keeps all projects and active selection unchanged on validation, quota and external update failures', () => {
    const storage = store(),
      first = projectFixture();
    bindWorkspaceStorage(storage);
    updateProjectLibrary(storage, { type: 'open', project: first });
    const before = storage.getItem(projectLibraryStorageKey);
    expect(() =>
      updateProjectLibrary(storage, { type: 'rename', id: first.id, name: '' }),
    ).toThrow();
    expect(storage.getItem(projectLibraryStorageKey)).toBe(before);
    const full = {
      getItem: storage.getItem,
      setItem: () => {
        throw new DOMException('full', 'QuotaExceededError');
      },
    };
    expect(() => updateProjectLibrary(full, { type: 'delete', id: first.id })).toThrow();
    expect(storage.getItem(projectLibraryStorageKey)).toBe(before);
    storage.setItem(projectLibraryStorageKey, before! + ' ');
    expect(() => updateProjectLibrary(storage, { type: 'delete', id: first.id })).toThrow(
      '別のタブ',
    );
  });
  it('validates IDs and count and never falls back from a corrupt library to an older single project', () => {
    const first = projectFixture();
    const data = {
      format: 'voice-atlas-project-library',
      version: 1,
      activeId: first.id,
      projects: [first],
    };
    expect(() =>
      parseProjectLibrary(JSON.stringify({ ...data, projects: [first, first] })),
    ).toThrow();
    expect(() =>
      parseProjectLibrary(JSON.stringify({ ...data, activeId: crypto.randomUUID() })),
    ).toThrow();
    expect(() =>
      parseProjectLibrary(
        JSON.stringify({
          ...data,
          projects: Array.from({ length: 21 }, () => ({ ...first, id: crypto.randomUUID() })),
          activeId: null,
        }),
      ),
    ).toThrow();
    const storage = store();
    storage.setItem(projectStorageKey, serializeProject(first));
    storage.setItem(projectLibraryStorageKey, '{broken');
    expect(() => readProject(storage)).toThrow();
    expect(() =>
      updateProjectLibrary(storage, { type: 'open', project: makeEmptyProject() }),
    ).toThrow();
    expect(storage.getItem(projectLibraryStorageKey)).toBe('{broken');
  });
});
