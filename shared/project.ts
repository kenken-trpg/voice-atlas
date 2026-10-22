import { z } from 'zod';
import { characterInputSchema, profileSchema } from './schema';
import { parseSavedRecipe } from './saved-recipe';
import { castingSessionSchema, maxCastingSessionFileBytes } from './casting';
import { parseLibrary, serializeLibrary, libraryStorageKey } from './voice-library';
import {
  parseLibraryComparison,
  serializeLibraryComparison,
  libraryComparisonStorageKey,
  libraryComparisonSessionSchema,
} from './library-comparison';
import { parseCastingBoard, serializeCastingBoard, castingBoardStorageKey } from './casting-board';
import { parseScript, serializeScript, scriptStorageKey, scriptSchema } from './script';
import {
  parseScriptLibrary,
  serializeScriptLibrary,
  scriptLibraryStorageKey,
} from './script-library';

export const projectStorageKey = 'voice-atlas-project-v1';
export const maxProjectBytes = 32 * 1024 * 1024;
const jsonBytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
const recipeSchema = z.unknown().transform((value, ctx) => {
  try {
    return parseSavedRecipe(value);
  } catch {
    ctx.addIssue({ code: 'custom', message: '声探しのレシピを確認してください。' });
    return z.NEVER;
  }
});
export const workbenchSchema = z.object({
  input: characterInputSchema,
  profile: profileSchema,
  recipe: recipeSchema.nullable(),
});
export const castingWorkSchema = z.object({
  session: castingSessionSchema,
  outcome: z.enum(['a', 'b', 'tie', 'undecided']),
  reason: z.string().max(1000),
});
export const documentKeys = {
  voiceLibrary: libraryStorageKey,
  libraryComparison: libraryComparisonStorageKey,
  castingBoard: castingBoardStorageKey,
  script: scriptStorageKey,
  scriptLibrary: scriptLibraryStorageKey,
} as const;
const projectSchema = z.object({
  format: z.literal('voice-atlas-project'),
  version: z.literal(1),
  id: z.uuid(),
  name: z.string().trim().min(1).max(100),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  documents: z.object({
    workbench: workbenchSchema.nullable(),
    casting: castingWorkSchema.nullable(),
    // Existing parsers also enforce document-specific byte limits and legacy versions.
    voiceLibrary: z.unknown(),
    libraryComparison: libraryComparisonSessionSchema.nullable(),
    castingBoard: z.unknown(),
    script: scriptSchema.nullable(),
    scriptLibrary: z.unknown(),
  }),
});
export function validateProject(value: unknown) {
  if (jsonBytes(value) > maxProjectBytes) throw new Error('作品JSONは32MiB以下にしてください。');
  const parsed = projectSchema.parse(value);
  const d = parsed.documents;
  const documents = {
    ...d,
    voiceLibrary: parseLibrary(JSON.stringify(d.voiceLibrary)),
    castingBoard: parseCastingBoard(JSON.stringify(d.castingBoard)),
    scriptLibrary: parseScriptLibrary(JSON.stringify(d.scriptLibrary)),
  };
  if (d.libraryComparison) serializeLibraryComparison(d.libraryComparison);
  if (d.script) serializeScript(d.script);
  if (d.workbench?.recipe && jsonBytes(d.workbench.recipe) > 4 * 1024 * 1024)
    throw new Error('声探しのレシピは4MiB以下にしてください。');
  if (d.casting && jsonBytes(d.casting.session) > maxCastingSessionFileBytes)
    throw new Error('比較セッションは8MiB以下にしてください。');
  return {
    ...parsed,
    documents: {
      ...documents,
      voiceLibrary: JSON.parse(serializeLibrary(documents.voiceLibrary)) as {
        format: 'voice-atlas-voice-library';
        version: 2;
        entries: typeof documents.voiceLibrary;
      },
      castingBoard: JSON.parse(serializeCastingBoard(documents.castingBoard)) as {
        format: 'voice-atlas-casting-board';
        version: 1;
        assignments: typeof documents.castingBoard;
      },
      scriptLibrary: JSON.parse(serializeScriptLibrary(documents.scriptLibrary)) as {
        format: 'voice-atlas-script-library';
        version: 1;
        entries: typeof documents.scriptLibrary;
      },
    },
  };
}
export type VoiceProject = ReturnType<typeof validateProject>;
export type ProjectDocuments = VoiceProject['documents'];
export type ProjectPart = keyof ProjectDocuments;
export type ProjectStorage = Pick<Storage, 'getItem' | 'setItem'>;
let boundStorage: ProjectStorage | undefined;
let expectedProjectText: string | null = null;

export function bindWorkspaceStorage(storage: ProjectStorage) {
  boundStorage = storage;
  expectedProjectText = storage.getItem(projectStorageKey);
}
export function projectChangedElsewhere(storage: ProjectStorage) {
  return storage === boundStorage && storage.getItem(projectStorageKey) !== expectedProjectText;
}
export function readWorkspaceProject(storage: ProjectStorage) {
  if (storage !== boundStorage) return readProject(storage);
  return expectedProjectText === null ? null : parseProject(expectedProjectText);
}
export function saveWorkspaceProject(
  project: VoiceProject,
  storage: ProjectStorage,
  replace = false,
) {
  if (!replace && projectChangedElsewhere(storage))
    throw new Error(
      '別のタブで作品が変更されています。現在の編集を作品JSONに書き出してから、作品を開き直してください。',
    );
  const text = serializeProject(project);
  storage.setItem(projectStorageKey, text);
  if (storage === boundStorage) expectedProjectText = text;
}

export function parseProject(text: string): VoiceProject {
  if (new TextEncoder().encode(text).length > maxProjectBytes)
    throw new Error('作品JSONは32MiB以下にしてください。');
  return validateProject(JSON.parse(text));
}
export function serializeProject(project: VoiceProject) {
  const text = JSON.stringify(validateProject(project));
  if (new TextEncoder().encode(text).length > maxProjectBytes)
    throw new Error('作品JSONは32MiB以下にしてください。');
  return text;
}
export function readProject(storage: ProjectStorage) {
  const raw = storage.getItem(projectStorageKey);
  return raw === null ? null : parseProject(raw);
}
export function legacyDocuments(storage: ProjectStorage): ProjectDocuments {
  const library = storage.getItem(libraryStorageKey);
  const comparison = storage.getItem(libraryComparisonStorageKey);
  const board = storage.getItem(castingBoardStorageKey);
  const script = storage.getItem(scriptStorageKey);
  const scripts = storage.getItem(scriptLibraryStorageKey);
  return {
    workbench: null,
    casting: null,
    voiceLibrary: JSON.parse(serializeLibrary(library === null ? [] : parseLibrary(library))),
    libraryComparison: comparison === null ? null : parseLibraryComparison(comparison),
    castingBoard: JSON.parse(serializeCastingBoard(board === null ? [] : parseCastingBoard(board))),
    script: script === null ? null : parseScript(script),
    scriptLibrary: JSON.parse(
      serializeScriptLibrary(scripts === null ? [] : parseScriptLibrary(scripts)),
    ),
  };
}
export function projectSummary(project: VoiceProject) {
  const d = project.documents;
  return `採用声${d.voiceLibrary.entries.length}件・配役${d.castingBoard.assignments.length}件・保存台本${d.scriptLibrary.entries.length}件・編集中の台本${d.script?.lines.length ?? 0}行`;
}

// A project occupies one storage item, so switching and saving never partially replace
// several legacy keys. Legacy browser data remains available outside the project.
export function readWorkspaceDocument(key: string, storage: ProjectStorage = localStorage) {
  const project = readWorkspaceProject(storage);
  const part = Object.entries(documentKeys).find(([, item]) => item === key)?.[0] as
    keyof typeof documentKeys | undefined;
  if (!part) throw new Error('未対応の保存先です。');
  if (!project) return storage.getItem(key);
  const value = project.documents[part];
  return value === null ? null : JSON.stringify(value);
}
export function writeWorkspaceDocument(
  key: string,
  text: string,
  storage: ProjectStorage = localStorage,
) {
  if (projectChangedElsewhere(storage))
    throw new Error(
      '別のタブで作品が変更されています。現在の編集を作品JSONに書き出してから、作品を開き直してください。',
    );
  const part = Object.entries(documentKeys).find(([, item]) => item === key)?.[0] as
    keyof typeof documentKeys | undefined;
  if (!part) throw new Error('未対応の保存先です。');
  const project = readWorkspaceProject(storage);
  if (!project) {
    storage.setItem(key, text);
    return;
  }
  const next = {
    ...project,
    updatedAt: new Date().toISOString(),
    documents: { ...project.documents, [part]: JSON.parse(text) },
  };
  saveWorkspaceProject(next, storage);
}
