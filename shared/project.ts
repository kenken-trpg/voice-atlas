import { z } from 'zod';
import {
  irodoriAssignmentsSchema,
  irodoriComparisonsSchema,
  irodoriSelectionSchema,
  irodoriSpeakerLinksSchema,
} from './irodori-candidates';
import { pronunciationsSchema } from './pronunciations';
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
export const projectLibraryStorageKey = 'voice-atlas-project-library-v1';
export const maxProjectCount = 20;
export const maxProjectLibraryBytes = 64 * 1024 * 1024;
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
    irodoriCandidates: irodoriSelectionSchema.default([]),
    irodoriAssignments: irodoriAssignmentsSchema.default([]),
    irodoriComparisons: irodoriComparisonsSchema.default([]),
    irodoriSpeakerLinks: irodoriSpeakerLinksSchema.default([]),
    pronunciations: pronunciationsSchema.default([]),
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
  if (d.irodoriAssignments.some((item) => !d.irodoriCandidates.includes(item.voiceId)))
    throw new Error('Irodoriの仮配役には作品で選んだ候補声を指定してください。');
  if (
    d.irodoriComparisons.some((item) =>
      item.voiceIds.some((id) => !d.irodoriCandidates.includes(id)),
    )
  )
    throw new Error('Irodoriの比較には作品で選んだ候補声を指定してください。');
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
let expectedLibraryText: string | null = null;

export function bindWorkspaceStorage(storage: ProjectStorage) {
  boundStorage = storage;
  expectedProjectText = storage.getItem(projectStorageKey);
  expectedLibraryText = storage.getItem(projectLibraryStorageKey);
}
export function projectChangedElsewhere(storage: ProjectStorage) {
  if (storage !== boundStorage) return false;
  const library = storage.getItem(projectLibraryStorageKey);
  return (
    library !== expectedLibraryText ||
    (library === null && storage.getItem(projectStorageKey) !== expectedProjectText)
  );
}
export function readWorkspaceProject(storage: ProjectStorage) {
  if (storage !== boundStorage) return readProject(storage);
  if (expectedLibraryText !== null) {
    const library = parseProjectLibrary(expectedLibraryText);
    return library.projects.find((p) => p.id === library.activeId) ?? null;
  }
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
  if (storage.getItem(projectLibraryStorageKey) !== null) {
    updateProjectLibrary(storage, { type: 'open', project }, undefined, replace);
    return;
  }
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
  const library = storage.getItem(projectLibraryStorageKey);
  if (library !== null) {
    const parsed = parseProjectLibrary(library);
    return parsed.projects.find((p) => p.id === parsed.activeId) ?? null;
  }
  const raw = storage.getItem(projectStorageKey);
  return raw === null ? null : parseProject(raw);
}
export function emptyProjectDocuments(): ProjectDocuments {
  return legacyDocuments({ getItem: () => null, setItem: () => {} });
}
export function makeEmptyProject(name = '新しい作品'): VoiceProject {
  const now = new Date().toISOString();
  return validateProject({
    format: 'voice-atlas-project',
    version: 1,
    id: crypto.randomUUID(),
    name,
    createdAt: now,
    updatedAt: now,
    documents: emptyProjectDocuments(),
  });
}
const librarySchema = z.object({
  format: z.literal('voice-atlas-project-library'),
  version: z.literal(1),
  activeId: z.uuid().nullable(),
  projects: z.array(z.unknown()).max(maxProjectCount),
});
export function parseProjectLibrary(text: string) {
  if (new TextEncoder().encode(text).length > maxProjectLibraryBytes)
    throw new Error('作品ライブラリは64MiB以下にしてください。');
  const raw = librarySchema.parse(JSON.parse(text));
  const projects = raw.projects.map(validateProject);
  if (
    new Set(projects.map((p) => p.id)).size !== projects.length ||
    (raw.activeId !== null && !projects.some((p) => p.id === raw.activeId))
  )
    throw new Error('作品IDまたは選択中の作品が不正です。');
  return { ...raw, projects };
}
export type ProjectLibrary = ReturnType<typeof parseProjectLibrary>;
export function readProjectLibrary(storage: ProjectStorage, snapshot = true): ProjectLibrary {
  const text =
    snapshot && storage === boundStorage
      ? expectedLibraryText
      : storage.getItem(projectLibraryStorageKey);
  if (text !== null) return parseProjectLibrary(text);
  const project = snapshot ? readWorkspaceProject(storage) : readProject(storage);
  return {
    format: 'voice-atlas-project-library',
    version: 1,
    activeId: project?.id ?? null,
    projects: project ? [project] : [],
  };
}
export type ProjectLibraryAction =
  | { type: 'open'; project: VoiceProject }
  | { type: 'select'; id: string }
  | { type: 'rename'; id: string; name: string }
  | { type: 'delete'; id: string };
export function updateProjectLibrary(
  storage: ProjectStorage,
  action: ProjectLibraryAction,
  current?: VoiceProject,
  replace = false,
) {
  if (!replace && projectChangedElsewhere(storage))
    throw new Error(
      '別のタブで作品が変更されています。現在の編集を作品JSONに書き出してから、作品を開き直してください。',
    );
  const library = readProjectLibrary(storage, !replace);
  let projects = [...library.projects],
    activeId = library.activeId;
  const put = (project: VoiceProject) => {
    const saved = validateProject(project);
    projects = projects.some((p) => p.id === saved.id)
      ? projects.map((p) => (p.id === saved.id ? saved : p))
      : [...projects, saved];
  };
  if (current) put(current);
  if (action.type === 'open') {
    put(action.project);
    activeId = action.project.id;
  } else {
    const target = projects.find((p) => p.id === action.id);
    if (!target) throw new Error('対象の作品が見つかりません。');
    if (action.type === 'select') activeId = target.id;
    if (action.type === 'rename')
      put({ ...target, name: action.name, updatedAt: new Date().toISOString() });
    if (action.type === 'delete') {
      projects = projects.filter((p) => p.id !== target.id);
      if (activeId === target.id) activeId = projects[0]?.id ?? null;
    }
  }
  const next = parseProjectLibrary(
    JSON.stringify({ format: 'voice-atlas-project-library', version: 1, activeId, projects }),
  );
  const text = JSON.stringify(next);
  if (new TextEncoder().encode(text).length > maxProjectLibraryBytes)
    throw new Error('作品ライブラリは64MiB以下にしてください。');
  storage.setItem(projectLibraryStorageKey, text);
  if (storage === boundStorage) expectedLibraryText = text;
  return next;
}
export function legacyDocuments(storage: ProjectStorage): ProjectDocuments {
  const library = storage.getItem(libraryStorageKey);
  const comparison = storage.getItem(libraryComparisonStorageKey);
  const board = storage.getItem(castingBoardStorageKey);
  const script = storage.getItem(scriptStorageKey);
  const scripts = storage.getItem(scriptLibraryStorageKey);
  return {
    irodoriCandidates: [],
    irodoriAssignments: [],
    irodoriComparisons: [],
    irodoriSpeakerLinks: [],
    workbench: null,
    pronunciations: [],
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
  return `採用声${d.voiceLibrary.entries.length}件・Irodori候補${d.irodoriCandidates.length}件・比較${d.irodoriComparisons.length}件・仮配役${d.irodoriAssignments.length}件・発話者対応${d.irodoriSpeakerLinks.length}件・配役${d.castingBoard.assignments.length}件・保存台本${d.scriptLibrary.entries.length}件・編集中の台本${d.script?.lines.length ?? 0}行`;
}

// A project occupies one storage item, so switching and saving never partially replace
// several legacy keys. Legacy browser data remains available outside the project.
export function readWorkspaceDocument(key: string, storage: ProjectStorage = localStorage) {
  const project = readWorkspaceProject(storage);
  const part = Object.entries(documentKeys).find(([, item]) => item === key)?.[0] as
    keyof typeof documentKeys | undefined;
  if (!part) throw new Error('未対応の保存先です。');
  if (!project) {
    if (storage.getItem(projectLibraryStorageKey) === null) return storage.getItem(key);
    const empty = emptyProjectDocuments()[part];
    return empty === null ? null : JSON.stringify(empty);
  }
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
    if (storage.getItem(projectLibraryStorageKey) !== null) {
      const fresh = makeEmptyProject();
      saveWorkspaceProject(
        { ...fresh, documents: { ...fresh.documents, [part]: JSON.parse(text) } },
        storage,
      );
      return;
    }
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
