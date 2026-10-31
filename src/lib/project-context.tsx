import {
  createContext,
  Fragment,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type Dispatch,
  type SetStateAction,
} from 'react';
import {
  legacyDocuments,
  readProject,
  readWorkspaceProject,
  bindWorkspaceStorage,
  saveWorkspaceProject,
  updateProjectLibrary,
  projectLibraryStorageKey,
  emptyProjectDocuments,
  type ProjectLibraryAction,
  type VoiceProject,
  type ProjectDocuments,
  type ProjectPart,
} from '../../shared/project';
import { pronunciationsSchema, type Pronunciation } from '../../shared/pronunciations';
import { type IrodoriAssignment } from '../../shared/irodori-candidates';

type Source = { snapshot: () => unknown; busy: () => boolean };
type Context = {
  initial: VoiceProject | null;
  loadError: string;
  register: (part: ProjectPart, source: Source) => () => void;
  partsReady: boolean;
  capture: () => ProjectDocuments;
  ensureIdle: () => void;
  commit: (project: VoiceProject, remount: boolean) => void;
  transition: (action: ProjectLibraryAction, current?: VoiceProject) => void;
  pronunciations: Pronunciation[];
  setPronunciations: (rules: Pronunciation[]) => void;
  irodoriAssignments: IrodoriAssignment[];
  setIrodoriAssignments: Dispatch<SetStateAction<IrodoriAssignment[]>>;
  irodoriAudioRevision: number;
  refreshIrodoriAudio: () => void;
};
const ProjectContext = createContext<Context | null>(null);
export function useProject() {
  const context = useContext(ProjectContext);
  if (!context) throw new Error('作品の保存コンテキストがありません。');
  return context;
}
export function useProjectPart<K extends ProjectPart>(
  part: K,
  snapshot: () => ProjectDocuments[K],
  busy: boolean,
) {
  const { register } = useProject();
  const current = useRef({ snapshot, busy });
  useLayoutEffect(() => {
    current.current = { snapshot, busy };
  });
  useLayoutEffect(
    () =>
      register(part, {
        snapshot: () => current.current.snapshot(),
        busy: () => current.current.busy,
      }),
    [part, register],
  );
}
export function ProjectProvider({ children }: { children: ReactNode }) {
  const [loaded] = useState(() => {
    try {
      bindWorkspaceStorage(localStorage);
      return { project: readProject(localStorage), error: '' };
    } catch {
      return {
        project: null,
        error:
          '保存済みの作品を読み込めませんでした。保存データは上書きしていません。作品JSONから復元してください。',
      };
    }
  });
  const [initial, setInitial] = useState(loaded.project);
  const [pronunciations, setReadings] = useState(loaded.project?.documents.pronunciations ?? []);
  const [irodoriAssignments, setIrodoriAssignments] = useState<IrodoriAssignment[]>(
    loaded.project?.documents.irodoriAssignments ?? [],
  );
  const [irodoriAudioRevision, setIrodoriAudioRevision] = useState(0);
  const [loadError, setLoadError] = useState(loaded.error);
  const [revision, setRevision] = useState(0);
  // The lazy casting workspace owns most parts; snapshots are partial until it registers.
  const [partsReady, setPartsReady] = useState(false);
  const sources = useRef(new Map<ProjectPart, Source>());
  const register = useRef<Context['register']>((part, source) => {
    sources.current.set(part, source);
    if (part === 'casting') setPartsReady(true);
    return () => {
      if (sources.current.get(part) === source) sources.current.delete(part);
    };
  }).current;
  const ensureIdle = () => {
    if ([...sources.current.values()].some((source) => source.busy()))
      throw new Error('生成・読み込み・確認の処理が完了してから作品を操作してください。');
  };
  const capture = () => {
    ensureIdle();
    const documents =
      readWorkspaceProject(localStorage)?.documents ??
      (localStorage.getItem(projectLibraryStorageKey) === null
        ? legacyDocuments(localStorage)
        : emptyProjectDocuments());
    for (const [part, source] of sources.current)
      Object.assign(documents, { [part]: source.snapshot() });
    documents.pronunciations = pronunciations;
    return documents;
  };
  const commit = (project: VoiceProject, remount: boolean) => {
    ensureIdle();
    // Validate and serialize before the single atomic setItem. UI changes follow success.
    saveWorkspaceProject(project, localStorage, remount);
    setLoadError('');
    if (remount) {
      setReadings(project.documents.pronunciations);
      setIrodoriAssignments(project.documents.irodoriAssignments);
      setIrodoriAudioRevision((value) => value + 1);
      setInitial(project);
      setRevision((value) => value + 1);
    }
  };
  const transition = (action: ProjectLibraryAction, current?: VoiceProject) => {
    ensureIdle();
    const previousId = readWorkspaceProject(localStorage)?.id;
    const library = updateProjectLibrary(localStorage, action, current);
    if (action.type === 'delete')
      void import('./script-audio-store')
        .then(({ deleteProjectAudio }) => deleteProjectAudio(action.id))
        .catch(() => {
          /* A cache cleanup failure must not undo a successful project deletion. */
        });
    const next = library.projects.find((p) => p.id === library.activeId) ?? null;
    setLoadError('');
    if (action.type === 'open' || action.type === 'select' || previousId !== next?.id) {
      setReadings(next?.documents.pronunciations ?? []);
      setIrodoriAssignments(next?.documents.irodoriAssignments ?? []);
      setIrodoriAudioRevision((value) => value + 1);
      setInitial(next);
      setRevision((value) => value + 1);
    }
  };
  return (
    <ProjectContext.Provider
      value={{
        initial,
        loadError,
        register,
        partsReady,
        capture,
        ensureIdle,
        commit,
        transition,
        pronunciations,
        setPronunciations: (rules) => setReadings(pronunciationsSchema.parse(rules)),
        irodoriAssignments,
        setIrodoriAssignments,
        irodoriAudioRevision,
        refreshIrodoriAudio: () => setIrodoriAudioRevision((value) => value + 1),
      }}
    >
      <Fragment key={revision}>{children}</Fragment>
    </ProjectContext.Provider>
  );
}
