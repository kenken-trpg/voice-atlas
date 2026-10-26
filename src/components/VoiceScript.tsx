import {
  readWorkspaceDocument,
  writeWorkspaceDocument,
  readWorkspaceProject,
} from '../../shared/project';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useProject, useProjectPart } from '../lib/project-context';
import {
  irodoriCandidates,
  irodoriSpeakerLinksSchema,
  type IrodoriSpeakerLink,
} from '../../shared/irodori-candidates';
import { readIrodoriAudio } from '../lib/irodori-audio-store';
import { type CastingAssignment } from '../../shared/casting-board';
import {
  emptyScript,
  makeScriptLine,
  maxScriptBytes,
  parseScript,
  scriptAudioKey,
  scriptSpokenText,
  scriptCandidate,
  scriptStorageKey,
  serializeScript,
  scriptSchema,
  type ScriptLine,
  type VoiceScript as VoiceScriptDocument,
} from '../../shared/script';
import {
  castingCandidateSchema,
  castingKey,
  generationSchema,
  castingRecipeFields,
  castingRecipeSummary,
  type CastingCandidate,
  type CastingInventory,
} from '../../shared/casting';
import { type AivisModelInfo } from '../../shared/aivis-model-info';
import { type LibraryAudition } from '../../shared/library-comparison';
import { download } from '../lib/http';
import { pauseOtherAudio } from './ComparisonPanel';
import { AivisModelDetails } from './AivisModelDetails';
import { ScriptAudioExport } from './ScriptAudioExport';
import { ScriptLibrary, type ScriptLibraryHandle } from './ScriptLibrary';
import { ScriptImport } from './ScriptImport';
import { PronunciationDictionary } from './PronunciationDictionary';
import { ScriptCasting } from './ScriptCasting';
import { ScriptRecast } from './ScriptRecast';
import { ScriptSceneSettings } from './ScriptSceneSettings';
import { ScriptGenerationPlan } from './ScriptGenerationPlan';
import { scriptGenerationReasons } from '../../shared/script-generation-reasons';
import { ScriptGenerationPanel } from './ScriptGenerationPanel';
import {
  startGenerationJob,
  updateGenerationRow,
  finishGenerationJob,
  generationRetryPlan,
  type ScriptGenerationJob,
  type ScriptRetryMode,
} from '../../shared/script-generation';
import { type ScriptRecastPlan } from '../../shared/script-recast';
import { makeRecastSnapshot, undoScriptRecast } from '../../shared/script-recast-history';
import { ScriptRecastHistory, type RecastMemory, type ScriptPreview } from './ScriptRecastHistory';

type Preview = ScriptPreview;
export function VoiceScript({
  assignments,
  disabled,
  active,
  inventory,
  checking,
  currentModel,
  onBusyChange,
}: {
  assignments: CastingAssignment[];
  disabled: boolean;
  active: boolean;
  inventory: CastingInventory | null;
  checking: boolean;
  currentModel: (candidate: CastingCandidate) => AivisModelInfo | undefined;
  onBusyChange: (busy: boolean) => void;
}) {
  const { initial: projectInitial, irodoriAssignments, irodoriAudioRevision } = useProject();
  const [speakerLinks, setSpeakerLinks] = useState<IrodoriSpeakerLink[]>(
    projectInitial?.documents.irodoriSpeakerLinks ?? [],
  );
  const [irodoriUrls, setIrodoriUrls] = useState<Record<string, string>>({});
  const [irodoriError, setIrodoriError] = useState('');
  const [renameFrom, setRenameFrom] = useState('');
  const [renameTo, setRenameTo] = useState('');
  const [initial] = useState(() => {
    try {
      const raw = readWorkspaceDocument(scriptStorageKey);
      return { script: raw ? parseScript(raw) : emptyScript(), error: '' };
    } catch {
      return {
        script: emptyScript(),
        error:
          '保存済みの台本を読み込めませんでした。保存データは上書きしていません。台本JSONから復元してください。',
      };
    }
  });
  const [script, setScript] = useState(initial.script);
  const [error, setError] = useState(initial.error);
  const [notice, setNotice] = useState('');
  const [opened, setOpened] = useState(false);
  const [busy, setBusy] = useState(false);
  const [excludedGenerationIds, setExcludedGenerationIds] = useState<string[]>([]);
  const [generationJob, setGenerationJob] = useState<ScriptGenerationJob | null>(null);
  const [cloudReview, setCloudReview] = useState<{
    script: VoiceScriptDocument;
    targets: ScriptLine[];
    forceId?: string;
    onlyIds?: string[];
    previousJob?: ScriptGenerationJob;
  } | null>(null);
  const cloudReviewRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (cloudReview) {
      cloudReviewRef.current?.scrollIntoView({ block: 'center' });
      cloudReviewRef.current?.focus();
    }
  }, [cloudReview]);
  const generationRef = useRef<ScriptGenerationJob | null>(null);
  const [stopping, setStopping] = useState(false);
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [cacheBusy, setCacheBusy] = useState(false);
  const [cacheReady, setCacheReady] = useState(false);
  const [deleteAudio, setDeleteAudio] = useState<'project' | 'all' | null>(null);
  const cacheGeneration = useRef(0);
  const cacheRunning = useRef(false);
  const scriptRef = useRef(script);
  useLayoutEffect(() => {
    scriptRef.current = script;
  });
  const [recastIds, setRecastIds] = useState<string[]>([]);
  const libraryRef = useRef<ScriptLibraryHandle>(null);
  const [generatingId, setGeneratingId] = useState<string | null>(null);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [followPlayback, setFollowPlayback] = useState(true);
  const rowRefs = useRef(new Map<string, HTMLLIElement>());
  useEffect(() => {
    if (playingId && followPlayback)
      rowRefs.current.get(playingId)?.scrollIntoView({ block: 'center' });
  }, [playingId, followPlayback]);
  const [previews, setPreviews] = useState<Record<string, Preview>>({});
  const [recastMemory, setRecastMemory] = useState<RecastMemory | null>(null);
  const memoryRef = useRef<RecastMemory | null>(null);
  const ownedUrls = useRef(new Set<string>());
  const comparisonRef = useRef<HTMLElement>(null);
  const previewRef = useRef(previews);
  const previousAudioKeys = useRef(new Map<string, string>());
  const controller = useRef<AbortController | null>(null);
  const running = useRef(false),
    importing = useRef(false);
  const audioRefs = useRef(new Map<string, HTMLAudioElement>());
  const queue = useRef<string[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);
  const baseLocked = disabled || busy || loading || exporting || cacheBusy;
  const locked = baseLocked || switching;
  useProjectPart('script', () => script, locked);
  useProjectPart('irodoriSpeakerLinks', () => speakerLinks, locked);
  useEffect(() => {
    if (!active || !opened) {
      setCloudReview(null);
      setIrodoriUrls({});
      return;
    }
    let current = true;
    let urls: string[] = [];
    setIrodoriUrls({});
    readIrodoriAudio()
      .then((blobs) => {
        if (!current) return;
        const next = Object.fromEntries(
          Object.entries(blobs).map(([hash, blob]) => [hash, URL.createObjectURL(blob)]),
        );
        urls = Object.values(next);
        setIrodoriUrls(next);
        setIrodoriError('');
      })
      .catch(() => {
        if (current) setIrodoriError('Irodoriの保存済み音声を読み込めませんでした。');
      });
    return () => {
      current = false;
      urls.forEach((url) => URL.revokeObjectURL(url));
    };
  }, [active, opened, irodoriAudioRevision]);
  function irodoriForSpeaker(speaker: string) {
    const explicit = speakerLinks.find((item) => item.speaker === speaker);
    return irodoriAssignments.find((item) => item.character === (explicit?.character ?? speaker));
  }
  function irodoriUrl(voiceId: string) {
    const sample = irodoriCandidates.find((voice) => voice.id === voiceId)?.samples[0];
    return sample ? irodoriUrls[sample.sha256] : undefined;
  }
  function linkSpeaker(speaker: string, character: string) {
    const result = irodoriSpeakerLinksSchema.safeParse([
      ...speakerLinks.filter((item) => item.speaker !== speaker),
      ...(character ? [{ speaker, character }] : []),
    ]);
    if (!result.success) {
      setIrodoriError(
        result.error.issues[0]?.message ?? '発話者の対応付けを保存できませんでした。',
      );
      return;
    }
    setSpeakerLinks(result.data);
    setIrodoriError('');
  }
  const scriptSpeakers = [
    ...new Set(
      script.lines
        .map((line) => line.character?.trim())
        .filter((name): name is string => Boolean(name)),
    ),
  ];
  const linkedSpeakers = [
    ...new Set([...scriptSpeakers, ...speakerLinks.map((item) => item.speaker)]),
  ];
  function renameSpeaker() {
    const from = renameFrom;
    const to = renameTo.trim();
    if (!from || !scriptSpeakers.includes(from) || !to || to === from) return;
    const count = script.lines.filter((line) => line.character?.trim() === from).length;
    setScript((current) => ({
      ...current,
      lines: current.lines.map((line) =>
        line.character?.trim() === from ? { ...line, character: to } : line,
      ),
    }));
    setSpeakerLinks((current) => {
      const old = current.find((item) => item.speaker === from);
      if (!old) return current;
      const withoutOld = current.filter((item) => item.speaker !== from);
      if (withoutOld.some((item) => item.speaker === to)) return withoutOld;
      return irodoriSpeakerLinksSchema.parse([
        ...withoutOld,
        { speaker: to, character: old.character },
      ]);
    });
    setRenameFrom('');
    setRenameTo('');
    setNotice(`${count}行の発話者名を変更しました。生成済み音声は保持しています。`);
  }
  function stop() {
    queue.current = [];
    setPlayingId(null);
    audioRefs.current.forEach((audio) => audio.pause());
    comparisonRef.current?.querySelectorAll('audio').forEach((audio) => audio.pause());
  }
  useEffect(() => {
    if (!active || !opened) {
      setCacheReady(false);
      cacheGeneration.current++;
      if (cacheRunning.current) {
        cacheRunning.current = false;
        setCacheBusy(false);
        onBusyChange(false);
      }
      controller.current?.abort();
      stop();
    }
  }, [active, opened]);
  useEffect(() => {
    if (active && opened && !cacheReady) void restoreAudio(true);
  }, [active, opened, disabled, busy, loading, exporting, switching, cacheReady, script]);
  useEffect(
    () => () => {
      cacheGeneration.current++;
      controller.current?.abort();
      audioRefs.current.forEach((audio) => audio.pause());
      ownedUrls.current.forEach((url) => URL.revokeObjectURL(url));
      ownedUrls.current.clear();
    },
    [],
  );
  function collectUrls() {
    const retained = new Set(
      [
        ...Object.values(previewRef.current),
        ...Object.values(memoryRef.current?.beforeAudio ?? {}),
      ].map((preview) => preview.url),
    );
    for (const url of ownedUrls.current)
      if (!retained.has(url)) {
        URL.revokeObjectURL(url);
        ownedUrls.current.delete(url);
      }
  }
  function discardRecastMemory() {
    stop();
    memoryRef.current = null;
    setRecastMemory(null);
    collectUrls();
  }
  function clear(ids = Object.keys(previewRef.current)) {
    stop();
    const next = { ...previewRef.current };
    for (const id of ids) {
      if (next[id]) previousAudioKeys.current.set(id, next[id].key);
      delete next[id];
    }
    previewRef.current = next;
    setPreviews(next);
    collectUrls();
  }
  function editLine(id: string, update: Partial<ScriptLine>) {
    const before = script.lines.find((line) => line.id === id);
    if (!before) return;
    const after = { ...before, ...update };
    if (update.text !== undefined && before.readingSource === 'dictionary') {
      delete after.spokenText;
      delete after.readingSource;
    }
    if (after.spokenText === undefined) delete after.readingSource;
    if (scriptAudioKey(before) !== scriptAudioKey(after)) clear([id]);
    else if (!('character' in update && Object.keys(update).length === 1)) stop();
    setScript((value) => ({
      ...value,
      lines: value.lines.map((line) => (line.id === id ? after : line)),
    }));
    setNotice('');
  }
  function audio(line: ScriptLine) {
    const preview = previews[line.id];
    return preview?.key === scriptAudioKey(line) ? preview : null;
  }
  function generationReason(line: ScriptLine) {
    return audio(line)
      ? '生成済み'
      : scriptGenerationReasons(line, previousAudioKeys.current.get(line.id)).join('・');
  }
  function insertLine(index: number, source?: ScriptLine) {
    if (locked || script.lines.length >= 20) return;
    stop();
    const line = source
      ? { ...structuredClone(source), id: crypto.randomUUID() }
      : makeScriptLine();
    const preview = source ? audio(source) : null;
    if (preview) {
      const next = {
        ...previewRef.current,
        [line.id]: { ...preview, key: scriptAudioKey(line) },
      };
      previewRef.current = next;
      setPreviews(next);
    }
    const lines = [...script.lines];
    lines.splice(index, 0, line);
    setScript({ ...script, lines });
    setNotice(
      source
        ? `第${index}行を複製し、第${index + 1}行に追加しました。${preview ? '生成済み音声も再利用しています。' : ''}`
        : `第${index + 1}行に空の行を追加しました。`,
    );
  }
  function availability(line: ScriptLine) {
    const candidate = scriptCandidate(line);
    if (!candidate) return '声を選択してください';
    if (!castingCandidateSchema.safeParse(candidate).success) return '現行カタログ対象外';
    if (checking) return '確認中';
    if (candidate.voice.engine === 'ElevenLabs')
      return inventory?.engines.some((engine) => engine.engine === 'ElevenLabs' && engine.ready)
        ? '試聴可能'
        : 'ElevenLabs未接続（サーバーのAPIキー・接続状態を確認してください）';
    if (inventory?.voices.some((voice) => castingKey(voice) === castingKey(candidate.voice)))
      return '試聴可能';
    return inventory?.engines.find((engine) => engine.engine === candidate.voice.engine)?.ready
      ? '未導入'
      : '未接続';
  }
  function generationIssue(line: ScriptLine) {
    if (!line.text.trim()) return 'セリフを入力してください';
    if (!scriptSpokenText(line).trim()) return '読み上げ文を入力してください';
    const status = availability(line);
    return status === '試聴可能' ? null : status;
  }
  function publishGeneration(job: ScriptGenerationJob | null) {
    setCloudReview(null);
    generationRef.current = job;
    setGenerationJob(job);
  }
  function retryGeneration(mode: ScriptRetryMode) {
    const job = generationRef.current;
    if (!job || locked || running.current) return;
    const plan = generationRetryPlan(script, job, mode);
    if (plan.invalidIds.length) {
      setError('生成条件が変わった行があります。台本側から対象を選び直してください。');
      return;
    }
    void generate(
      undefined,
      plan.lines.map((line) => line.id),
      job,
    );
  }
  function act(action: () => void) {
    setError('');
    setNotice('');
    try {
      action();
    } catch {
      setError(
        '台本を保存・復元できませんでした。形式・件数・保存容量を確認してください。現在の台本は保持しています。',
      );
    }
  }
  function applyRecast(plan: ScriptRecastPlan) {
    if (locked || running.current || importing.current) return;
    const snapshot = makeRecastSnapshot(script, plan);
    const beforeAudio: Record<string, Preview> = {};
    for (const row of snapshot.rows) {
      const preview = previewRef.current[row.before.id];
      if (preview?.key === scriptAudioKey(row.before)) beforeAudio[row.before.id] = preview;
    }
    const memory = { snapshot, beforeAudio };
    memoryRef.current = memory;
    setRecastMemory(memory);
    clear(plan.audioChangedIds);
    setScript(plan.script);
    setRecastIds(plan.audioChangedIds);
    setError('');
    setNotice(
      `${plan.changedIds.length}行の設定を差し替えました。音声が変わる${plan.audioChangedIds.length}行だけ再生成できます。ライブラリへの反映は保存してください。`,
    );
  }
  async function storedAudio(
    operation: (projectId: string, token: number) => Promise<void>,
    automatic = false,
  ) {
    if (
      disabled ||
      busy ||
      loading ||
      exporting ||
      switching ||
      running.current ||
      importing.current ||
      cacheRunning.current
    )
      return;
    let projectId: string | undefined;
    try {
      projectId = readWorkspaceProject(localStorage)?.id;
    } catch {
      /* Report below without changing saved data. */
    }
    if (!projectId) {
      setCacheReady(true);
      if (!automatic) setError('先に作品をブラウザに保存してください。');
      return;
    }
    const token = ++cacheGeneration.current;
    cacheRunning.current = true;
    if (!automatic) {
      setCacheBusy(true);
      onBusyChange(true);
    }
    setError('');
    try {
      await operation(projectId, token);
    } catch (cause) {
      if (token === cacheGeneration.current)
        setError(
          cause instanceof Error &&
            cause.name !== 'QuotaExceededError' &&
            cause.message.length < 200
            ? cause.message
            : '音声を保存・読み込みできませんでした。保存容量を確認してください。現在の音声は保持しています。',
        );
    } finally {
      if (token === cacheGeneration.current) {
        setCacheReady(true);
        cacheRunning.current = false;
        if (!automatic) {
          setCacheBusy(false);
          onBusyChange(false);
        }
      }
    }
  }
  async function restoreAudio(automatic = false) {
    await storedAudio(async (projectId, token) => {
      const { loadScriptAudio } = await import('../lib/script-audio-store');
      const snapshot = scriptRef.current;
      const saved = await loadScriptAudio(projectId, snapshot.lines);
      if (token !== cacheGeneration.current || scriptRef.current !== snapshot) return;
      const next = { ...previewRef.current };
      let count = 0;
      for (const item of saved) {
        const line = snapshot.lines.find((l) => l.id === item.lineId)!;
        if (next[line.id]?.key === item.key) continue;
        const url = URL.createObjectURL(item.blob);
        ownedUrls.current.add(url);
        next[line.id] = { key: item.key, url, blob: item.blob, audition: item.audition };
        count++;
      }
      previewRef.current = next;
      setPreviews(next);
      collectUrls();
      if (count || !automatic)
        setNotice(`条件が一致する保存音声を${count}行読み込みました。音声生成は行っていません。`);
    }, automatic);
  }
  async function saveAudio() {
    await storedAudio(async (projectId, token) => {
      const saved = readWorkspaceProject(localStorage);
      if (
        JSON.stringify(saved?.documents.script) !==
        JSON.stringify(scriptSchema.parse(scriptRef.current))
      )
        throw new Error('現在の台本を含む作品を先にブラウザに保存してください。');
      const sources = scriptRef.current.lines.flatMap((line) => {
        const preview = audio(line);
        return preview ? [{ line, blob: preview.blob, audition: preview.audition }] : [];
      });
      const { saveScriptAudio } = await import('../lib/script-audio-store');
      await saveScriptAudio(projectId, sources);
      if (token === cacheGeneration.current)
        setNotice(
          `${sources.length}行の音声をこのブラウザに保存しました。再起動後に台本を開くと、条件が一致する音声を再利用します。`,
        );
    });
  }
  async function generate(
    forceId?: string,
    onlyIds?: string[],
    previousJob?: ScriptGenerationJob,
    cloudConfirmed = false,
  ) {
    if (
      locked ||
      !cacheReady ||
      cacheRunning.current ||
      running.current ||
      importing.current ||
      !active ||
      !opened ||
      checking
    )
      return;
    if (previousJob && generationRef.current !== previousJob) return;
    const targets = script.lines.filter((line) =>
      forceId
        ? line.id === forceId
        : (!onlyIds || onlyIds.includes(line.id)) && (previousJob || !audio(line)),
    );
    if (!targets.length || targets.some((line) => generationIssue(line))) return;
    if (
      !cloudConfirmed &&
      targets.some((line) => scriptCandidate(line)?.voice.engine === 'ElevenLabs')
    ) {
      setCloudReview({ script, targets, forceId, onlyIds, previousJob });
      return;
    }
    setCloudReview(null);
    let job: ScriptGenerationJob;
    try {
      job = startGenerationJob(script, targets, previousJob);
    } catch {
      setError('生成対象を確認できませんでした。現在の台本と音声は保持しています。');
      return;
    }
    const update = (next: ScriptGenerationJob) => {
      job = next;
      publishGeneration(next);
    };
    update(job);
    stop();
    running.current = true;
    setBusy(true);
    setStopping(false);
    onBusyChange(true);
    setError('');
    setNotice('');
    const request = new AbortController();
    controller.current = request;
    let completed = 0;
    try {
      for (const line of targets) {
        if (request.signal.aborted) break;
        update(updateGenerationRow(job, line.id, 'generating'));
        setGeneratingId(line.id);
        const candidate = castingCandidateSchema.parse(scriptCandidate(line));
        const model = currentModel(candidate);
        const response = await fetch('/api/casting/preview', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            candidate: { voice: candidate.voice, recipe: candidate.recipe },
            text: scriptSpokenText(line),
          }),
          signal: request.signal,
        });
        if (!response.ok) {
          const body = await response.json();
          throw new Error(body.error || '音声を生成できませんでした。');
        }
        const blob = await response.blob();
        if (request.signal.aborted) break;
        let generation: LibraryAudition['generation'] = null;
        try {
          const parsed = generationSchema.safeParse(
            JSON.parse(
              decodeURIComponent(response.headers.get('X-Voice-Atlas-Generation') || 'null'),
            ),
          );
          if (parsed.success && parsed.data.engine === candidate.voice.engine)
            generation = parsed.data;
        } catch {
          /* Optional provenance. */
        }
        const url = URL.createObjectURL(blob);
        ownedUrls.current.add(url);
        const next = {
          ...previewRef.current,
          [line.id]: {
            key: scriptAudioKey(line),
            url,
            blob,
            audition: { generation, ...(model ? { modelInfo: structuredClone(model) } : {}) },
          },
        };
        previewRef.current = next;
        setPreviews(next);
        collectUrls();
        update(updateGenerationRow(job, line.id, 'succeeded'));
        completed++;
      }
      setNotice(
        request.signal.aborted
          ? '生成を中止しました。生成済みの行は保持しています。'
          : `${completed}行の音声を生成しました。`,
      );
    } catch (e) {
      if (request.signal.aborted) setNotice('生成を中止しました。生成済みの行は保持しています。');
      else {
        const failedLine = targets[completed];
        const message = e instanceof Error ? e.message : '音声を生成できませんでした。';
        if (failedLine) update(updateGenerationRow(job, failedLine.id, 'failed', message));
        setError(
          `第${script.lines.findIndex((line) => line.id === failedLine?.id) + 1}行：${message} 生成済みの行は保持しています。`,
        );
      }
    } finally {
      update(finishGenerationJob(job));
      controller.current = null;
      running.current = false;
      setBusy(false);
      setStopping(false);
      setGeneratingId(null);
      onBusyChange(false);
    }
  }
  async function playNext() {
    const id = queue.current[0];
    if (!id) {
      setPlayingId(null);
      return;
    }
    const element = audioRefs.current.get(id);
    if (!element) {
      stop();
      return;
    }
    setPlayingId(id);
    element.currentTime = 0;
    try {
      await element.play();
    } catch {
      if (queue.current[0] === id) {
        stop();
        setError('連続試聴を開始できませんでした。各行の再生ボタンで試聴してください。');
      }
    }
  }
  async function restore(file?: File) {
    if (!file || locked || importing.current || running.current) return;
    importing.current = true;
    setLoading(true);
    setError('');
    setNotice('');
    try {
      if (file.size > maxScriptBytes) throw new Error('size');
      const saved = parseScript(await file.text());
      libraryRef.current?.replace(saved, () =>
        writeWorkspaceDocument(scriptStorageKey, serializeScript(saved)),
      );
    } catch {
      setError(
        '台本JSONの形式・20行/8MiBの上限・保存容量を確認してください。現在の台本と音声は保持しています。',
      );
    } finally {
      importing.current = false;
      setLoading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }
  const allReady = script.lines.length > 0 && script.lines.every((line) => audio(line));
  const missing = script.lines.filter((line) => !audio(line));
  const selectedMissing = missing.filter((line) => !excludedGenerationIds.includes(line.id));
  const recastMissing = missing.filter((line) => recastIds.includes(line.id));
  return (
    <details
      id="production-script"
      className="voice-script"
      onToggle={(event) => {
        if (event.target === event.currentTarget) setOpened(event.currentTarget.open);
      }}
    >
      <summary>台本を作成・試聴する</summary>
      <section aria-label="台本の試聴">
        <h4>確定した声を台本で聴く</h4>
        <p>
          20行まで、各行300文字。キャスティング表から声を選び、台本の順番で生成・試聴できます。声は割り当て時の設定をコピーします。後から表を変更・削除しても台本の声は変わりません。
        </p>
        <p>
          編集中の台本は「台本をブラウザに保存」またはJSONで保存してください。保存・復元する内容は台本と声の設定です。音声は行ごとにWAVで保存できます。
        </p>
        {error && <p role="alert">{error}</p>}
        {notice && <p role="status">{notice}</p>}
        <details id="production-audio-storage">
          <summary>台本音声の保存と再利用</summary>
          <section aria-label="台本音声の保存と再利用">
            <p>
              先に現在の台本を含む作品をブラウザに保存してください。音声はこのブラウザ専用で、作品JSONには含めません。1行20MiB・1作品64MiB・全作品128MiBまで保存します。
            </p>
            <div className="casting-actions">
              <button
                className="secondary-button"
                disabled={locked || !cacheReady || !script.lines.some((line) => audio(line))}
                onClick={() => void saveAudio()}
              >
                台本音声をブラウザに保存
              </button>
              <button
                className="secondary-button"
                disabled={locked || !cacheReady}
                onClick={() => void restoreAudio()}
              >
                保存した台本音声を読み込む
              </button>
              <button
                className="text-button"
                disabled={locked || !cacheReady}
                onClick={() => setDeleteAudio('project')}
              >
                この作品の保存音声を削除
              </button>
              <button
                className="text-button"
                disabled={locked || !cacheReady}
                onClick={() => setDeleteAudio('all')}
              >
                全作品の保存音声を削除
              </button>
            </div>
            {cacheBusy && <p role="status">保存音声を処理しています。</p>}
            {deleteAudio && (
              <div role="group" aria-label="保存音声の削除確認">
                <p>
                  {deleteAudio === 'all' ? '全作品' : 'この作品'}
                  の保存音声を削除します。編集中の音声・台本・声の設定は保持します。
                </p>
                <button
                  className="secondary-button"
                  disabled={locked}
                  onClick={() =>
                    void storedAudio(async (id, token) => {
                      const { deleteProjectAudio } = await import('../lib/script-audio-store');
                      await deleteProjectAudio(deleteAudio === 'all' ? null : id);
                      if (token === cacheGeneration.current) {
                        setDeleteAudio(null);
                        setNotice('保存音声を削除しました。現在の試聴音声は保持しています。');
                      }
                    })
                  }
                >
                  確認した保存音声を削除
                </button>
                <button className="text-button" onClick={() => setDeleteAudio(null)}>
                  保存音声の削除をキャンセル
                </button>
              </div>
            )}
          </section>
        </details>
        <PronunciationDictionary
          script={script}
          disabled={locked}
          onApply={(plan) => {
            if (locked) return;
            clear(plan.audioChangedIds);
            setScript(plan.script);
            setNotice(
              `${plan.changedIds.length}行の読み上げ文を反映しました。音声が変わる行だけ再生成してください。`,
            );
          }}
        />
        <ScriptLibrary
          ref={libraryRef}
          script={script}
          disabled={baseLocked}
          onPendingChange={setSwitching}
          onOpen={(value) => {
            discardRecastMemory();
            clear();
            previousAudioKeys.current.clear();
            publishGeneration(null);
            setExcludedGenerationIds([]);
            cacheGeneration.current++;
            cacheRunning.current = false;
            setCacheReady(false);
            setScript(value);
            setRecastIds([]);
            setError('');
            setNotice('');
          }}
        />
        <ScriptImport
          assignments={assignments}
          disabled={locked}
          gapMs={script.gapMs}
          inventory={inventory}
          checking={checking}
          onImport={(value) =>
            libraryRef.current?.replace(value, () =>
              writeWorkspaceDocument(scriptStorageKey, serializeScript(value)),
            )
          }
        />
        <ScriptCasting
          script={script}
          assignments={assignments}
          disabled={locked}
          onApply={applyRecast}
        />
        <ScriptSceneSettings
          script={script}
          assignments={assignments}
          disabled={locked}
          inventory={inventory}
          checking={checking}
          onApply={applyRecast}
        />
        <ScriptRecast
          script={script}
          assignments={assignments}
          disabled={locked}
          inventory={inventory}
          checking={checking}
          onApply={applyRecast}
        />
        <ScriptRecastHistory
          ref={comparisonRef}
          script={script}
          memory={recastMemory}
          previews={previews}
          disabled={locked}
          onPlay={(event) => {
            queue.current = [];
            setPlayingId(null);
            pauseOtherAudio(event);
          }}
          onDiscard={discardRecastMemory}
          onUndo={() =>
            act(() => {
              if (locked || running.current || importing.current || !memoryRef.current) return;
              const memory = memoryRef.current;
              const restored = undoScriptRecast(script, memory.snapshot);
              stop();
              const next = { ...previewRef.current };
              for (const row of memory.snapshot.rows) {
                if (next[row.before.id])
                  previousAudioKeys.current.set(row.before.id, next[row.before.id].key);
                delete next[row.before.id];
                const preview = memory.beforeAudio[row.before.id];
                if (preview?.key === scriptAudioKey(row.before)) next[row.before.id] = preview;
              }
              previewRef.current = next;
              setPreviews(next);
              memoryRef.current = null;
              setRecastMemory(null);
              setScript(restored);
              setRecastIds([]);
              collectUrls();
              setNotice(
                '直前の差し替えを取り消しました。保持していた元の音声を戻し、対象外の編集は保持しています。ライブラリへの反映は保存してください。',
              );
            })
          }
        />
        <label>
          台本名
          <input
            aria-label="台本名"
            maxLength={100}
            value={script.title}
            disabled={locked}
            onChange={(e) => {
              stop();
              setScript({ ...script, title: e.target.value });
            }}
          />
        </label>
        <div className="casting-actions">
          <button
            className="secondary-button"
            disabled={locked || script.lines.length >= 20}
            onClick={() => insertLine(script.lines.length)}
          >
            台本に行を追加
          </button>
          <button
            className="secondary-button"
            disabled={locked}
            onClick={() =>
              act(() => {
                writeWorkspaceDocument(scriptStorageKey, serializeScript(script));
                setNotice(
                  '台本をブラウザ内に保存しました。音声は再読み込み後に再生成してください。',
                );
              })
            }
          >
            台本をブラウザに保存
          </button>
          <button
            className="secondary-button"
            disabled={locked}
            onClick={() => act(() => download('voice-atlas-script.json', serializeScript(script)))}
          >
            台本JSONを保存
          </button>
          <button
            className="secondary-button"
            disabled={locked}
            onClick={() => fileRef.current?.click()}
          >
            台本JSONを読み込む
          </button>
          <input
            hidden
            type="file"
            ref={fileRef}
            accept=".json,application/json"
            aria-label="台本JSONファイル"
            onChange={(e) => void restore(e.target.files?.[0])}
          />
        </div>
        <p role="status">
          台本：{script.lines.length}行 / 音声生成済み
          {script.lines.filter((line) => audio(line)).length}行
        </p>
        <ScriptGenerationPlan
          lines={script.lines}
          reusable={(line) => Boolean(audio(line))}
          reason={generationReason}
          excluded={excludedGenerationIds}
          disabled={locked}
          issue={generationIssue}
          currentModel={currentModel}
          onToggle={(id) => {
            setCloudReview(null);
            setExcludedGenerationIds((ids) =>
              ids.includes(id) ? ids.filter((value) => value !== id) : [...ids, id],
            );
          }}
        />
        <div className="casting-actions">
          <button
            className="secondary-button"
            disabled={
              locked ||
              !cacheReady ||
              checking ||
              !selectedMissing.length ||
              selectedMissing.some(
                (line) =>
                  !line.text.trim() ||
                  !scriptSpokenText(line).trim() ||
                  availability(line) !== '試聴可能',
              )
            }
            onClick={() =>
              void generate(
                undefined,
                selectedMissing.map((line) => line.id),
              )
            }
          >
            未生成の行を台本順に生成
          </button>
          {recastIds.length > 0 && (
            <button
              className="secondary-button"
              disabled={
                locked ||
                !cacheReady ||
                checking ||
                !recastMissing.length ||
                recastMissing.some(
                  (line) =>
                    !line.text.trim() ||
                    !scriptSpokenText(line).trim() ||
                    availability(line) !== '試聴可能',
                )
              }
              onClick={() => void generate(undefined, recastIds)}
            >
              差し替えた行の未生成音声を生成
            </button>
          )}
          <button
            className="secondary-button"
            disabled={locked || !allReady || playingId !== null}
            onClick={() => {
              setError('');
              queue.current = script.lines.map((line) => line.id);
              void playNext();
            }}
          >
            台本順に連続試聴
          </button>
          <button className="secondary-button" disabled={playingId === null} onClick={stop}>
            台本の連続試聴を停止
          </button>
          <button
            className="secondary-button"
            disabled={playingId === null}
            onClick={() => {
              const row = playingId ? rowRefs.current.get(playingId) : null;
              row?.focus();
              row?.scrollIntoView({ block: 'center' });
            }}
          >
            連続試聴中の行へ移動
          </button>
        </div>
        <label className="script-playback-follow">
          <input
            type="checkbox"
            checked={followPlayback}
            onChange={(event) => setFollowPlayback(event.target.checked)}
          />
          連続試聴中の行へ自動スクロール
        </label>
        {cloudReview && (
          <div
            className="script-generation"
            role="group"
            aria-label="ElevenLabsへの台本送信確認"
            ref={cloudReviewRef}
            tabIndex={-1}
          >
            <h5>ElevenLabsへ送る台本の行を確認</h5>
            <p>
              今回の生成は{cloudReview.targets.length}行です。以下のElevenLabs対象行の読み上げ文を
              外部APIへ送信し、アカウントの利用枠を消費します。文字数は料金の見積もりではありません。
              他の製品の行は、それぞれの接続先で生成します。
            </p>
            <ol>
              {cloudReview.targets.flatMap((line) => {
                const candidate = scriptCandidate(line);
                if (
                  candidate?.recipe.engine !== 'ElevenLabs' ||
                  candidate.voice.engine !== 'ElevenLabs'
                )
                  return [];
                return [
                  <li key={line.id}>
                    <strong>
                      第{cloudReview.script.lines.findIndex((item) => item.id === line.id) + 1}行 ：
                      {line.character ?? line.assignment?.character} · {candidate.voice.name}
                    </strong>
                    <p>
                      声ID：{candidate.voice.voiceId} / モデル：{candidate.recipe.modelId}
                    </p>
                    <p>{castingRecipeSummary(candidate)}</p>
                    <p>
                      読み上げ文（{Array.from(scriptSpokenText(line)).length}文字）：
                      {scriptSpokenText(line)}
                    </p>
                  </li>,
                ];
              })}
            </ol>
            {cloudReview.script !== script && (
              <p role="status">台本が変更されました。生成操作から対象を確認し直してください。</p>
            )}
            <button
              className="secondary-button"
              disabled={
                locked ||
                checking ||
                !cacheReady ||
                cloudReview.script !== script ||
                cloudReview.targets.some((line) => generationIssue(line))
              }
              onClick={() => {
                if (cloudReview.script !== scriptRef.current) return;
                void generate(
                  cloudReview.forceId,
                  cloudReview.onlyIds,
                  cloudReview.previousJob,
                  true,
                );
              }}
            >
              確認した行をElevenLabsへ送信して生成
            </button>
            <button className="secondary-button" onClick={() => setCloudReview(null)}>
              台本の送信をキャンセル
            </button>
            <p>
              自動再試行はしません。中止しても送信済みの要求は利用枠を消費する場合があります。
              失敗した行を再試行するときは、再び送信対象を確認します。
            </p>
          </div>
        )}
        <ScriptGenerationPanel
          job={generationJob}
          script={script}
          busy={busy}
          disabled={locked || !cacheReady || checking}
          stopping={stopping}
          issue={generationIssue}
          onStop={() => {
            setStopping(true);
            controller.current?.abort();
          }}
          onRetry={retryGeneration}
          onDismiss={() => publishGeneration(null)}
        />
        <label>
          結合WAVの行間（ミリ秒）
          <input
            aria-label="結合WAVの行間"
            type="number"
            min={0}
            max={5000}
            step={1}
            disabled={locked}
            value={script.gapMs}
            onChange={(event) => {
              const value = Number(event.target.value);
              if (Number.isInteger(value) && value >= 0 && value <= 5000)
                setScript({ ...script, gapMs: value });
            }}
          />
        </label>
        <ScriptAudioExport
          script={script}
          sources={script.lines.map(audio)}
          disabled={locked}
          active={active && opened}
          onPreparingChange={(value) => {
            setExporting(value);
            onBusyChange(value);
          }}
        />
        <section className="irodori-script-links" aria-label="台本発話者とIrodori仮配役">
          <h4>発話者のIrodori仮配役を確認</h4>
          <p>
            発話者名と仮配役のキャラクター名が一致すれば自動で表示します。別名の場合はここで対応付けます。検証音声の試聴用で、この台詞の音声生成には使いません。
          </p>
          {irodoriError && <p role="alert">{irodoriError}</p>}
          <fieldset disabled={locked || scriptSpeakers.length === 0}>
            <legend>同じ発話者の全行を改名</legend>
            <label>
              変更前の発話者
              <select
                aria-label="一括改名する発話者"
                value={scriptSpeakers.includes(renameFrom) ? renameFrom : ''}
                onChange={(event) => setRenameFrom(event.target.value)}
              >
                <option value="">発話者を選択</option>
                {scriptSpeakers.map((speaker) => (
                  <option key={speaker} value={speaker}>
                    {speaker}
                  </option>
                ))}
              </select>
            </label>
            <label>
              新しい発話者名
              <input
                aria-label="一括改名後の発話者名"
                maxLength={100}
                value={renameTo}
                onChange={(event) => setRenameTo(event.target.value)}
              />
            </label>
            <button
              className="secondary-button"
              disabled={
                !renameFrom ||
                !scriptSpeakers.includes(renameFrom) ||
                !renameTo.trim() ||
                renameTo.trim() === renameFrom
              }
              onClick={renameSpeaker}
            >
              {renameFrom
                ? `${script.lines.filter((line) => line.character?.trim() === renameFrom).length}行の発話者名を変更`
                : '発話者名をまとめて変更'}
            </button>
          </fieldset>
          {linkedSpeakers.length === 0 && <p>発話者名付きの台本を取り込むと対応付けできます。</p>}
          {linkedSpeakers.map((speaker) => {
            const link = speakerLinks.find((item) => item.speaker === speaker);
            const assignment = irodoriForSpeaker(speaker);
            return (
              <div key={speaker}>
                <label>
                  {speaker}の仮配役
                  <select
                    aria-label={`${speaker}のIrodori仮配役`}
                    disabled={locked}
                    value={link?.character ?? ''}
                    onChange={(event) => linkSpeaker(speaker, event.target.value)}
                  >
                    <option value="">名前の一致で自動対応</option>
                    {link &&
                      !irodoriAssignments.some((item) => item.character === link.character) && (
                        <option value={link.character}>
                          仮配役が見つかりません：{link.character}
                        </option>
                      )}
                    {irodoriAssignments.map((item) => (
                      <option key={item.character} value={item.character}>
                        {item.character}：
                        {irodoriCandidates.find((voice) => voice.id === item.voiceId)!.name}
                      </option>
                    ))}
                  </select>
                </label>
                <span>
                  {assignment
                    ? `表示中：${irodoriCandidates.find((voice) => voice.id === assignment.voiceId)!.name}`
                    : '対応する仮配役なし'}
                  {scriptSpeakers.includes(speaker) ? '' : '（現在の台本には発話者なし）'}
                </span>
              </div>
            );
          })}
        </section>
        <ol className="evaluation-history">
          {script.lines.map((line, index) => {
            const candidate = scriptCandidate(line),
              preview = audio(line);
            const chosen = line.assignment;
            return (
              <li
                key={line.id}
                aria-label={`台本の第${index + 1}行`}
                tabIndex={-1}
                aria-current={playingId === line.id ? 'true' : undefined}
                ref={(node) => {
                  if (node) rowRefs.current.set(line.id, node);
                  else rowRefs.current.delete(line.id);
                }}
              >
                <strong>
                  第{index + 1}行{generatingId === line.id ? ' · 生成中' : ''}
                  {playingId === line.id ? ' · 連続試聴中' : ''}
                </strong>
                <p>音声状態：{generationReason(line)}</p>
                {line.character && <p>発話者：{line.character}</p>}
                <label>
                  発話者名
                  <input
                    aria-label={`第${index + 1}行の発話者名`}
                    maxLength={100}
                    disabled={locked}
                    value={line.character ?? ''}
                    onChange={(event) =>
                      editLine(line.id, {
                        character: event.target.value.trim() ? event.target.value : undefined,
                      })
                    }
                  />
                </label>
                {line.character &&
                  (() => {
                    const assignment = irodoriForSpeaker(line.character.trim());
                    if (!assignment) return null;
                    const voice = irodoriCandidates.find((item) => item.id === assignment.voiceId)!;
                    const url = irodoriUrl(assignment.voiceId);
                    return (
                      <div className="irodori-script-preview">
                        <p>
                          Irodori仮配役：{assignment.character} → {voice.name}
                          （保存済み検証音声の試聴のみ）
                        </p>
                        {url ? (
                          <audio
                            controls
                            src={url}
                            onPlay={pauseOtherAudio}
                            aria-label={`第${index + 1}行のIrodori仮配役音声`}
                          />
                        ) : (
                          <p>試聴音声は未読み込みです。</p>
                        )}
                      </div>
                    );
                  })()}
                <label>
                  キャラクターと場面
                  <select
                    aria-label={`第${index + 1}行の声`}
                    value={chosen ? 'snapshot' : ''}
                    disabled={locked}
                    onChange={(e) => {
                      if (e.target.value === 'snapshot') return;
                      const assignment =
                        assignments.find((item) => item.id === e.target.value) ?? null;
                      editLine(line.id, {
                        assignment: assignment ? structuredClone(assignment) : null,
                      });
                    }}
                  >
                    <option value="">声を選択</option>
                    {chosen && (
                      <option value="snapshot">
                        割り当て済み：{chosen.project} / {chosen.character} / {chosen.scene}
                      </option>
                    )}
                    {assignments.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.project} / {item.character} / {item.scene}
                      </option>
                    ))}
                  </select>
                </label>
                {candidate && (
                  <>
                    <p>
                      {candidate.voice.engine} · {candidate.voice.name} / {candidate.voice.style} ·{' '}
                      {availability(line)}
                    </p>
                    <details>
                      <summary>割り当てた声の設定</summary>
                      <p>
                        {castingRecipeFields(candidate)
                          .map(
                            (field) =>
                              `${field.label}：${(candidate.recipe as unknown as Record<string, number>)[field.key]}${field.unit}`,
                          )
                          .join(' ／ ')}
                      </p>
                      <p>選択理由：{chosen!.comparison.reason}</p>
                    </details>
                  </>
                )}
                <label>
                  セリフ
                  <textarea
                    aria-label={`第${index + 1}行のセリフ`}
                    maxLength={300}
                    disabled={locked}
                    value={line.text}
                    onChange={(e) => editLine(line.id, { text: e.target.value })}
                  />
                </label>
                <label>
                  <input
                    type="checkbox"
                    aria-label={`第${index + 1}行の読み上げ文を別に指定`}
                    checked={line.spokenText !== undefined}
                    disabled={locked}
                    onChange={(e) =>
                      editLine(line.id, {
                        spokenText: e.target.checked ? line.text : undefined,
                        readingSource: e.target.checked ? 'manual' : undefined,
                      })
                    }
                  />
                  読み上げ文を別に指定
                </label>
                {line.spokenText !== undefined && (
                  <label>
                    読み上げ文{line.readingSource === 'dictionary' ? '（辞書から反映）' : ''}
                    <textarea
                      aria-label={`第${index + 1}行の読み上げ文`}
                      maxLength={300}
                      disabled={locked}
                      value={line.spokenText}
                      onChange={(e) =>
                        editLine(line.id, { spokenText: e.target.value, readingSource: 'manual' })
                      }
                    />
                  </label>
                )}
                <div className="casting-actions">
                  <button
                    className="secondary-button"
                    disabled={locked || script.lines.length >= 20}
                    onClick={() => insertLine(index)}
                  >
                    第{index + 1}行の前に行を挿入
                  </button>
                  <button
                    className="secondary-button"
                    disabled={locked || script.lines.length >= 20}
                    onClick={() => insertLine(index + 1)}
                  >
                    第{index + 1}行の後に行を挿入
                  </button>
                  <button
                    className="secondary-button"
                    disabled={locked || script.lines.length >= 20}
                    onClick={() => insertLine(index + 1, line)}
                  >
                    第{index + 1}行を複製
                  </button>
                  <button
                    className="secondary-button"
                    disabled={
                      locked ||
                      !cacheReady ||
                      checking ||
                      !line.text.trim() ||
                      !scriptSpokenText(line).trim() ||
                      availability(line) !== '試聴可能'
                    }
                    onClick={() => void generate(line.id)}
                  >
                    第{index + 1}行を{preview ? '再生成' : '生成'}
                  </button>
                  <button
                    className="secondary-button"
                    disabled={locked || index === 0}
                    onClick={() => {
                      stop();
                      const lines = [...script.lines];
                      [lines[index - 1], lines[index]] = [lines[index], lines[index - 1]];
                      setScript({ ...script, lines });
                    }}
                  >
                    第{index + 1}行を上へ
                  </button>
                  <button
                    className="secondary-button"
                    disabled={locked || index === script.lines.length - 1}
                    onClick={() => {
                      stop();
                      const lines = [...script.lines];
                      [lines[index], lines[index + 1]] = [lines[index + 1], lines[index]];
                      setScript({ ...script, lines });
                    }}
                  >
                    第{index + 1}行を下へ
                  </button>
                  <button
                    className="text-button"
                    disabled={locked}
                    onClick={() => {
                      clear([line.id]);
                      previousAudioKeys.current.delete(line.id);
                      setScript({
                        ...script,
                        lines: script.lines.filter((row) => row.id !== line.id),
                      });
                    }}
                  >
                    第{index + 1}行を削除
                  </button>
                </div>
                {preview && (
                  <>
                    <audio
                      controls
                      src={preview.url}
                      aria-label={`台本の第${index + 1}行の試聴`}
                      ref={(node) => {
                        if (node) audioRefs.current.set(line.id, node);
                        else audioRefs.current.delete(line.id);
                      }}
                      onPlay={(event) => {
                        if (queue.current[0] !== line.id) {
                          queue.current = [];
                          setPlayingId(null);
                        }
                        pauseOtherAudio(event);
                      }}
                      onEnded={() => {
                        if (queue.current[0] === line.id) {
                          queue.current.shift();
                          void playNext();
                        }
                      }}
                      onPause={(event) => {
                        if (queue.current[0] === line.id && !event.currentTarget.ended) stop();
                      }}
                      onError={() => {
                        stop();
                        setError('音声を再生できませんでした。この行の再生成をお試しください。');
                      }}
                    />
                    <a
                      className="secondary-button"
                      href={preview.url}
                      download={`voice-atlas-script-${String(index + 1).padStart(2, '0')}.wav`}
                    >
                      第{index + 1}行のWAVを保存
                    </a>
                    <p>
                      今回の生成エンジン版：{preview.audition.generation?.engineVersion ?? '未取得'}
                    </p>
                    {candidate?.voice.engine === 'AivisSpeech' && (
                      <AivisModelDetails historical saved={preview.audition.modelInfo} />
                    )}
                  </>
                )}
              </li>
            );
          })}
        </ol>
      </section>
    </details>
  );
}
