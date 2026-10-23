import { validateProject, legacyDocuments } from '../../shared/project';
import { libraryStorageKey, makeLibraryEntry, serializeLibrary } from '../../shared/voice-library';
import { castingBoardStorageKey, serializeCastingBoard } from '../../shared/casting-board';
import { scriptStorageKey, serializeScript } from '../../shared/script';
import { scriptFixture } from './script';
import { makeCastingEvaluation } from './casting';

export function projectFixture() {
  const values = new Map<string, string>();
  const store = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
  const fixture = scriptFixture();
  store.setItem(castingBoardStorageKey, serializeCastingBoard(fixture.assignments));
  store.setItem(scriptStorageKey, serializeScript(fixture.script));
  store.setItem(
    libraryStorageKey,
    serializeLibrary([
      makeLibraryEntry(makeCastingEvaluation(), '案内人', '通常', '比較理由を保持'),
    ]),
  );
  return validateProject({
    format: 'voice-atlas-project',
    version: 1,
    id: '11111111-1111-4111-8111-111111111111',
    name: '導入シナリオ',
    createdAt: '2026-10-22T00:00:00Z',
    updatedAt: '2026-10-22T00:00:00Z',
    documents: legacyDocuments(store),
  });
}
