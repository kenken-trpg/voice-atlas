import { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  ArrowDownToLine,
  ArrowRight,
  AudioLines,
  Check,
  ChevronRight,
  CircleHelp,
  ExternalLink,
  ImagePlus,
  LoaderCircle,
  Mic2,
  RefreshCw,
  SlidersHorizontal,
  Sparkles,
  Volume2,
  X,
} from 'lucide-react';
import {
  axes,
  axisLabels,
  defaultText,
  neutralProfile,
  providerLabels,
  defaultAnthropicModel,
  defaultGeminiModel,
  defaultDeepseekModel,
  type Provider,
  type Analysis,
  type Capabilities,
  type Engine,
  type Preferences,
  type Profile,
  type Recipe,
  type CharacterInput,
} from '../shared/schema';
import { catalogReviewedAt, voices } from '../shared/catalog';
import { recommend } from '../shared/recommend';
import { voiceAvailability, type VoiceAvailability } from '../shared/voicevox';
import { parseSavedRecipe, maxRecipeFileBytes, type Evaluation } from '../shared/saved-recipe';
import {
  captureEvaluationEvidence,
  engineInfoSchema,
  type EngineInfo,
} from '../shared/evaluation-evidence';
import { ComparisonPanel, pauseOtherAudio } from './components/ComparisonPanel';
import { EvaluationWorkbench } from './components/EvaluationWorkbench';
import { CastingWorkspace } from './components/CastingWorkspace';
import { HelpTip } from './components/HelpTip';
import { VoiceMark } from './components/VoiceMark';
import { RecipeControls } from './components/RecipeControls';
import { AvailabilityBadge, AvailabilityHelp } from './components/AvailabilityBadge';
import { CharacterContext } from './components/CharacterContext';
import { jsonRequest, download } from './lib/http';
import { ProjectProvider, useProject, useProjectPart } from './lib/project-context';
import { ListeningComparison } from './components/ListeningComparison';
import { ProjectPanel, type ProductionStep } from './components/ProjectPanel';
import { ConnectionGuide } from './components/ConnectionGuide';
import { IrodoriCandidates } from './components/IrodoriCandidates';
import './styles.css';

type Mode = 'manual' | Provider;
type ImageData = { url: string; name: string };
const presets: { name: string; note: string; profile: Profile }[] = [
  {
    name: '凛と、落ち着いて',
    note: '低めの声と、控えめな抑揚',
    profile: { pitch: 30, energy: 30, warmth: 40, airiness: 25 },
  },
  {
    name: '明るく、親しみやすく',
    note: '軽快なリズムと、柔らかい響き',
    profile: { pitch: 72, energy: 78, warmth: 78, airiness: 25 },
  },
  {
    name: 'そっと、ささやく',
    note: '息を含んだ声と、長めの余韻',
    profile: { pitch: 62, energy: 15, warmth: 85, airiness: 90 },
  },
];
const ends: Record<(typeof axes)[number], [string, string]> = {
  pitch: ['低め', '高め'],
  energy: ['静か', '活発'],
  warmth: ['シャープ', '柔らかい'],
  airiness: ['張りのある', '息を含む'],
};
const axisHelp: Record<(typeof axes)[number], string> = {
  pitch:
    '低めから高めまで、希望する声の方向を指定します。調声レシピの「音高」とは別に、候補の順位に影響します。',
  energy: '静かな語りから活発な演技まで、希望する勢いを指定します。',
  warmth: 'シャープな響きから柔らかい響きまで、創作上の印象を指定します。',
  airiness: '張りのある声から息を含んだ声までを指定します。ささやきスタイルの候補にも影響します。',
};
function App() {
  const { initial } = useProject();
  const restoredWorkbench = initial?.documents.workbench;
  const restoredRecipe = restoredWorkbench?.recipe;
  const recipeTimestamp = useRef(restoredRecipe?.createdAt ?? new Date().toISOString());
  const [image, setImage] = useState<ImageData | null>(null);
  const [mode, setMode] = useState<Mode>('manual');
  const [consent, setConsent] = useState(false);
  const [direction, setDirection] = useState(restoredWorkbench?.input.direction ?? '');
  const [inputMode, setInputMode] = useState<CharacterInput['mode']>(
    restoredWorkbench?.input.mode ?? 'image',
  );
  const [characterText, setCharacterText] = useState(restoredWorkbench?.input.text ?? '');
  const [profileInput, setProfileInput] = useState<CharacterInput | null>(
    restoredRecipe?.version === 3 ? (restoredRecipe.profileInput ?? null) : null,
  );
  const [profile, setProfile] = useState<Profile>(
    restoredWorkbench?.profile ?? { ...neutralProfile },
  );
  const [preferences, setPreferences] = useState<Preferences>(
    restoredRecipe &&
      restoredRecipe.version !== 1 &&
      recommend(restoredRecipe.profile, restoredRecipe.preferences).some(
        (item) => item.voice.id === restoredRecipe.voice.id,
      )
      ? restoredRecipe.preferences
      : { engine: 'all', budget: 'all' },
  );
  const [availableOnly, setAvailableOnly] = useState(false);
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [source, setSource] = useState<Mode>(restoredRecipe?.source ?? 'manual');
  const [edited, setEdited] = useState(restoredRecipe?.manuallyAdjusted ?? false);
  const [hasResults, setHasResults] = useState(!!restoredRecipe);
  const [selectedId, setSelectedId] = useState<string | null>(restoredRecipe?.voice.id ?? null);
  const [recipes, setRecipes] = useState<Record<string, Recipe>>(() => {
    if (!restoredRecipe) return {};
    return {
      ...(restoredRecipe.version !== 1
        ? Object.fromEntries(
            restoredRecipe.candidates.map((item) => [item.voiceId, item.parameters]),
          )
        : {}),
      ...(restoredRecipe.parameters
        ? { [restoredRecipe.voice.id]: restoredRecipe.parameters }
        : {}),
    };
  });
  const [comparisonIds, setComparisonIds] = useState<[string, string] | null>(
    restoredRecipe && restoredRecipe.version !== 1 ? restoredRecipe.comparisonIds : null,
  );
  const [evaluations, setEvaluations] = useState<Evaluation[]>(
    restoredRecipe && restoredRecipe.version !== 1 ? restoredRecipe.evaluations : [],
  );
  const [evaluationOpen, setEvaluationOpen] = useState(false);
  const [castingOpen, setCastingOpen] = useState(false);
  const [notice, setNotice] = useState('');
  const [loadingRecipe, setLoadingRecipe] = useState(false);
  const [text, setText] = useState(restoredRecipe?.sampleText ?? defaultText);
  const [caps, setCaps] = useState<Capabilities | null>(null);
  const [checking, setChecking] = useState(false);
  const connectionGeneration = useRef(0);
  const [busy, setBusy] = useState<'analysis' | 'audio' | null>(null);
  const [guideBusy, setGuideBusy] = useState(false);
  const [loadingImage, setLoadingImage] = useState(false);
  const [error, setError] = useState('');
  const [visualCorrection, setVisualCorrection] = useState('');
  const [audioCache, setAudioCache] = useState<
    Record<string, { key: string; url: string; engineInfo: EngineInfo | null }>
  >({});
  const audioCacheRef = useRef(audioCache);
  const generatingRef = useRef(false);
  const [dragging, setDragging] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const recipeFileRef = useRef<HTMLInputElement>(null);
  const imageGeneration = useRef(0);
  const requestRef = useRef<AbortController | null>(null);
  const resultsRef = useRef<HTMLElement>(null);
  const detailRef = useRef<HTMLElement>(null);
  const externalProvider = mode !== 'manual' && mode !== 'ollama';
  const providerName = mode === 'manual' ? '手動' : providerLabels[mode];
  const sentData =
    inputMode === 'image'
      ? characterText.trim()
        ? '画像・キャラクター設定と補足'
        : '画像と補足'
      : 'キャラクター設定と補足';
  function currentInput(): CharacterInput {
    return { mode: inputMode, text: characterText, direction };
  }
  const inputChanged =
    hasResults &&
    profileInput !== null &&
    JSON.stringify(profileInput) !== JSON.stringify(currentInput());

  async function refresh() {
    const generation = ++connectionGeneration.current;
    setChecking(true);
    try {
      const result = await jsonRequest<Capabilities>('/api/capabilities');
      if (generation === connectionGeneration.current) setCaps(result);
    } catch {
      if (generation === connectionGeneration.current) {
        setCaps(null);
        setError('接続状態を確認できませんでした。アプリのサーバーを確認してください。');
      }
    } finally {
      if (generation === connectionGeneration.current) setChecking(false);
    }
  }
  useEffect(() => {
    void refresh();
    return () => requestRef.current?.abort();
  }, []);
  useEffect(
    () => () => {
      Object.values(audioCacheRef.current).forEach((audio) => URL.revokeObjectURL(audio.url));
    },
    [],
  );
  const availability = useMemo(
    () =>
      Object.fromEntries(
        voices.map((voice) => [voice.id, voiceAvailability(voice, caps?.voicevox, checking)]),
      ) as Record<string, VoiceAvailability>,
    [caps, checking],
  );
  const recommendations = useMemo(
    () =>
      recommend(profile, preferences).filter(
        (item) => !availableOnly || availability[item.voice.id] === 'available',
      ),
    [profile, preferences, availableOnly, availability],
  );
  const allRecommendations = useMemo(
    () => recommend(profile, { engine: 'all', budget: 'all' }),
    [profile],
  );
  const voicevoxVoices = voices.filter((voice) => voice.engine === 'VOICEVOX');
  const selected =
    recommendations.find((item) => item.voice.id === selectedId) || recommendations[0];
  function getRecipe(id: string): Recipe {
    return recipes[id] ?? allRecommendations.find((item) => item.voice.id === id)!.recipe!;
  }
  const recipe = selected?.recipe ? getRecipe(selected.voice.id) : null;
  function audioKey(parameters: Recipe) {
    return JSON.stringify([text, parameters]);
  }
  function getAudio(id: string) {
    const audio = audioCache[id];
    return audio?.key === audioKey(getRecipe(id)) ? audio.url : '';
  }
  const audioUrl = selected?.recipe ? getAudio(selected.voice.id) : '';
  const audioLabel = selected ? `${selected.voice.name} / ${selected.voice.style}` : '';
  function clearAudio() {
    Object.values(audioCacheRef.current).forEach((audio) => URL.revokeObjectURL(audio.url));
    audioCacheRef.current = {};
    setAudioCache({});
  }
  function changeRecipe(id: string, parameters: Recipe) {
    setRecipes((current) => ({ ...current, [id]: parameters }));
    setEdited(true);
  }

  async function loadImage(file?: File) {
    if (!file || busy) return;
    const generation = ++imageGeneration.current;
    setLoadingImage(true);
    setError('');
    try {
      if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type))
        throw new Error('PNG・JPEG・WebPの画像を選んでください。');
      if (file.size > 8 * 1024 * 1024) throw new Error('画像は8MB以下にしてください。');
      const url = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error('ファイルを読み込めませんでした。'));
        reader.readAsDataURL(file);
      });
      if (generation !== imageGeneration.current) return;
      setImage({ url, name: file.name });
      setAnalysis(null);
      setVisualCorrection('');
      setInputMode('image');
      setProfileInput(null);
      setConsent(false);
      setHasResults(false);
      clearAudio();
      setRecipes({});
      setComparisonIds(null);
      setEvaluations([]);
      setNotice('');
      setSource('manual');
      setEdited(false);
    } catch (e) {
      if (generation === imageGeneration.current)
        setError(e instanceof Error ? e.message : '画像を読み込めませんでした。');
    } finally {
      if (generation === imageGeneration.current) setLoadingImage(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }
  function revealResults() {
    setTimeout(
      () => resultsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }),
      50,
    );
  }
  function manualSearch(next?: Profile) {
    if (next) setProfile({ ...next });
    setSource('manual');
    setAnalysis(null);
    setProfileInput(currentInput());
    setEdited(false);
    setHasResults(true);
    setSelectedId(null);
    setError('');
    revealResults();
  }
  function applyVisualCorrection() {
    const correction = visualCorrection.trim();
    if (!correction) return;
    const next = [characterText.trim(), `画像についての作者の訂正: ${correction}`]
      .filter(Boolean)
      .join('\n');
    if (next.length > 2000) {
      setError('キャラクター設定は2000文字以内にしてください。');
      return;
    }
    setCharacterText(next);
    setVisualCorrection('');
    setConsent(false);
    setError('');
    document
      .getElementById('character-setting')
      ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    document.getElementById('character-setting')?.focus({ preventScroll: true });
  }
  async function analyze() {
    if (mode === 'manual') {
      manualSearch();
      return;
    }
    if (inputMode === 'image' && !image) {
      setError('解析したい人物やキャラクターの画像を選んでください。');
      return;
    }
    if (inputMode === 'text' && !characterText.trim()) {
      setError('役柄・性格・話し方などのキャラクター設定を入力してください。');
      return;
    }
    if (externalProvider && !consent) {
      setError(`${sentData}の${providerName}への送信に同意してください。`);
      return;
    }
    const controller = new AbortController();
    requestRef.current = controller;
    setBusy('analysis');
    setError('');
    try {
      const result = await jsonRequest<{ analysis: Analysis }>(
        '/api/analyze',
        {
          provider: mode,
          inputMode,
          ...(inputMode === 'image' ? { image: image!.url } : {}),
          characterText,
          direction,
          consent,
        },
        controller.signal,
      );
      if (!result.analysis.subjectFound) {
        setError(result.analysis.summary);
        return;
      }
      setAnalysis(result.analysis);
      setVisualCorrection('');
      setProfileInput(currentInput());
      setProfile(result.analysis.profile);
      setSource(mode);
      setEdited(false);
      setHasResults(true);
      setSelectedId(null);
      revealResults();
    } catch (e) {
      if (!controller.signal.aborted)
        setError(e instanceof Error ? e.message : '解析に失敗しました。');
    } finally {
      if (requestRef.current === controller) {
        requestRef.current = null;
        setBusy(null);
      }
    }
  }
  async function preview(ids = selected && recipe ? [selected.voice.id] : []) {
    if (!ids.length || generatingRef.current || busy || loadingRecipe) return;
    if (ids.some((id) => availability[id] !== 'available')) {
      setError(
        '試聴できない候補が含まれています。接続を再確認するか、試聴可能な話者・スタイルを選んでください。',
      );
      return;
    }
    generatingRef.current = true;
    const controller = new AbortController();
    requestRef.current = controller;
    setBusy('audio');
    setError('');
    const jobs = ids.map((id) => ({ id, parameters: { ...getRecipe(id) } }));
    const sampleText = text;
    try {
      for (const { id, parameters } of jobs) {
        const key = JSON.stringify([sampleText, parameters]);
        if (audioCacheRef.current[id]?.key === key) continue;
        const response = await fetch('/api/preview', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ voiceId: id, recipe: parameters, text: sampleText }),
          signal: controller.signal,
        });
        if (!response.ok) {
          const data = await response.json();
          throw new Error(
            `${voices.find((voice) => voice.id === id)!.name}：${data.error || '音声を生成できませんでした。'}`,
          );
        }
        const blob = await response.blob();
        if (controller.signal.aborted) break;
        let engineInfo: EngineInfo | null = null;
        try {
          const header = response.headers.get('X-Voice-Atlas-Engine');
          const parsed = engineInfoSchema.safeParse(
            header ? JSON.parse(decodeURIComponent(header)) : null,
          );
          if (parsed.success) engineInfo = parsed.data;
        } catch {
          /* Missing or malformed optional metadata does not invalidate audio. */
        }
        const previous = audioCacheRef.current[id];
        if (previous) URL.revokeObjectURL(previous.url);
        audioCacheRef.current = {
          ...audioCacheRef.current,
          [id]: { key, url: URL.createObjectURL(blob), engineInfo },
        };
        setAudioCache(audioCacheRef.current);
      }
    } catch (e) {
      if (!controller.signal.aborted)
        setError(e instanceof Error ? e.message : '音声を生成できませんでした。');
    } finally {
      generatingRef.current = false;
      if (requestRef.current === controller) {
        requestRef.current = null;
        setBusy(null);
      }
    }
  }
  function recipeSnapshot(createdAt = new Date().toISOString()) {
    if (!selected) return null;
    return {
      format: 'voice-atlas-recipe',
      version: 3,
      createdAt,
      source,
      manuallyAdjusted: edited,
      note: 'Voice Atlasによる創作上の演出案。VOICEVOX等のプロジェクトファイルではありません。',
      voice: selected.voice,
      profile,
      parameters: recipe,
      guide: selected.guide,
      sampleText: text,
      catalogReviewedAt,
      credit: selected.voice.credit,
      preferences,
      candidates: voicevoxVoices.map((voice) => ({
        voiceId: voice.id,
        parameters: getRecipe(voice.id),
      })),
      comparisonIds,
      evaluations,
      characterInput: currentInput(),
      profileInput,
    };
  }
  function exportRecipe() {
    if (!selected) return;
    download(`voice-atlas-${selected.voice.id}.json`, JSON.stringify(recipeSnapshot(), null, 2));
  }
  function startComparison() {
    const rankedIds = allRecommendations
      .filter((item) => item.voice.engine === 'VOICEVOX')
      .map((item) => item.voice.id);
    const availableIds = rankedIds.filter((id) => availability[id] === 'available');
    const ids = [...availableIds, ...rankedIds.filter((id) => availability[id] !== 'available')];
    const first =
      selected?.voice.engine === 'VOICEVOX' &&
      (availability[selected.voice.id] === 'available' || availableIds.length === 0)
        ? selected.voice.id
        : ids[0];
    setComparisonIds([first, ids.find((id) => id !== first)!]);
    setNotice('');
  }
  function recordEvaluation(outcome: Evaluation['outcome'], reason: string) {
    if (!comparisonIds || evaluations.length >= 100 || !comparisonIds.every((id) => getAudio(id)))
      return;
    const evaluation: Evaluation = {
      recordedAt: new Date().toISOString(),
      profile: { ...profile },
      sampleText: text,
      candidates: comparisonIds.map((id) => ({
        voiceId: id,
        parameters: { ...getRecipe(id) },
      })) as Evaluation['candidates'],
      outcome,
      reason,
      ...(profileInput ? { characterInput: { ...profileInput } } : {}),
      evidence: captureEvaluationEvidence(
        profile,
        comparisonIds,
        comparisonIds.map((id) => audioCache[id]?.engineInfo ?? null) as [
          EngineInfo | null,
          EngineInfo | null,
        ],
      ),
    };
    setEvaluations((current) => [...current, evaluation]);
    if (outcome === 'a' || outcome === 'b') {
      setAvailableOnly(false);
      setSelectedId(comparisonIds[outcome === 'a' ? 0 : 1]);
      setPreferences({ engine: 'VOICEVOX', budget: preferences.budget });
    }
    setNotice('評価を記録しました。JSONで保存すると、比較条件と理由も残せます。');
  }
  async function importRecipe(file?: File) {
    if (!file || disabled) return;
    setLoadingRecipe(true);
    setError('');
    setNotice('');
    try {
      if (file.size > maxRecipeFileBytes) throw new Error('レシピJSONは4MB以下にしてください。');
      let input: unknown;
      try {
        input = JSON.parse(await file.text());
      } catch {
        throw new Error('有効なJSONファイルを指定してください。');
      }
      const saved = parseSavedRecipe(input);
      recipeTimestamp.current = saved.createdAt;
      const restored: Record<string, Recipe> = {};
      if (saved.version !== 1)
        saved.candidates.forEach((item) => {
          restored[item.voiceId] = item.parameters;
        });
      if (saved.parameters) restored[saved.voice.id] = saved.parameters;
      clearAudio();
      setRecipes(restored);
      setProfile(saved.profile);
      const restoredPreferences =
        saved.version !== 1
          ? saved.preferences
          : { engine: 'all' as const, budget: 'all' as const };
      const selectedVisible = recommend(saved.profile, restoredPreferences).some(
        (item) => item.voice.id === saved.voice.id,
      );
      setPreferences(selectedVisible ? restoredPreferences : { engine: 'all', budget: 'all' });
      setAvailableOnly(false);
      setSelectedId(saved.voice.id);
      setText(saved.sampleText);
      setSource(saved.source);
      setEdited(saved.manuallyAdjusted);
      setComparisonIds(saved.version !== 1 ? saved.comparisonIds : null);
      setEvaluations(saved.version !== 1 ? saved.evaluations : []);
      ++imageGeneration.current;
      setImage(null);
      setAnalysis(null);
      const restoredInput = saved.version === 3 ? saved.characterInput : undefined;
      setInputMode(restoredInput?.mode ?? 'image');
      setCharacterText(restoredInput?.text ?? '');
      setDirection(restoredInput?.direction ?? '');
      setProfileInput(
        saved.version === 3
          ? saved.profileInput !== undefined
            ? saved.profileInput
            : (restoredInput ?? null)
          : null,
      );
      setConsent(false);
      setMode('manual');
      setHasResults(true);
      setNotice(
        `レシピを復元しました。音声は再生成してください。${saved.catalogReviewedAt !== catalogReviewedAt ? '保存時からカタログの確認日が変わっています。公式情報も確認してください。' : ''}`,
      );
      revealResults();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'レシピを読み込めませんでした。');
    } finally {
      setLoadingRecipe(false);
      if (recipeFileRef.current) recipeFileRef.current.value = '';
    }
  }
  const disabled = Boolean(busy) || guideBusy || loadingImage || loadingRecipe;
  useProjectPart(
    'workbench',
    () => ({
      input: currentInput(),
      profile,
      recipe: hasResults ? parseSavedRecipe(recipeSnapshot(recipeTimestamp.current)) : null,
    }),
    disabled,
  );
  const providerReady =
    mode === 'manual' ||
    (mode === 'ollama' && inputMode === 'text'
      ? Boolean(caps?.ollama.textReady ?? caps?.ollama.ready)
      : Boolean(caps?.[mode]?.ready));
  function navigateProduction(step: ProductionStep) {
    if (step !== 'discovery') setCastingOpen(true);
    requestAnimationFrame(() => {
      const target = document.getElementById(
        step === 'discovery'
          ? 'workspace'
          : step === 'casting'
            ? 'production-casting'
            : 'production-script',
      );
      if (!target) return;
      let parent = target.parentElement;
      while (parent) {
        if (parent instanceof HTMLDetailsElement) parent.open = true;
        parent = parent.parentElement;
      }
      if (target instanceof HTMLDetailsElement) target.open = true;
      target.scrollIntoView({ block: 'start' });
      const focusTarget =
        target instanceof HTMLDetailsElement ? target.querySelector('summary') : target;
      focusTarget?.focus({ preventScroll: true });
    });
  }
  return (
    <>
      <header className="site-header">
        <div className="header-inner">
          <a href="/" className="brand" aria-label="Voice Atlas ホーム">
            <span className="brand-icon">
              <AudioLines size={22} />
            </span>
            <span>
              voice<span className="brand-light">atlas</span>
              <sup>ALPHA</sup>
            </span>
          </a>
          <nav aria-label="メインナビゲーション">
            <a href="#workspace">声を探す</a>
            <a href="#how-it-works">使い方</a>
            <button
              className="connection-button"
              onClick={() => setSettingsOpen(!settingsOpen)}
              aria-expanded={settingsOpen}
            >
              <span
                className={`status-dot ${caps?.ollama.ready || caps?.ollama.textReady || caps?.openai.ready || caps?.anthropic?.ready || caps?.gemini?.ready || caps?.deepseek?.ready ? 'online' : ''}`}
              />
              <span>接続設定</span>
              <SlidersHorizontal size={15} />
            </button>
          </nav>
        </div>
      </header>
      <main>
        <section className="hero">
          <div className="eyebrow">
            <span /> CHARACTER VOICE DISCOVERY
          </div>
          <div className="hero-line">
            <div>
              <h1>
                イメージに、<span>声を。</span>
              </h1>
              <p>
                そのキャラクターに似合う声を、見つけよう。
                <br className="mobile-break" />
                画像やキャラクター設定から、音声ソフトと調声のレシピへ。
              </p>
            </div>
            <div className="hero-note">
              <AudioLines size={36} />
              <span>
                ひとつのイメージから、
                <br />
                いくつもの声の可能性。
              </span>
            </div>
          </div>
        </section>
        <ProjectPanel onNavigate={navigateProduction} />
        <ConnectionGuide
          disabled={Boolean(busy) || loadingImage || loadingRecipe}
          onBusyChange={setGuideBusy}
        />
        <IrodoriCandidates />
        <ListeningComparison />
        <div className="recipe-import">
          <button
            className="secondary-button"
            disabled={disabled}
            onClick={() => recipeFileRef.current?.click()}
          >
            レシピJSONを読み込む
          </button>
          <input
            ref={recipeFileRef}
            type="file"
            accept=".json,application/json"
            hidden
            aria-label="レシピJSONファイル"
            onChange={(e) => void importRecipe(e.target.files?.[0])}
          />
          <small>保存した声・調整・比較記録を復元します。</small>
          <button
            className="secondary-button"
            aria-expanded={evaluationOpen}
            aria-controls="evaluation-workbench"
            onClick={() => setEvaluationOpen(!evaluationOpen)}
          >
            {evaluationOpen ? '評価記録の集計を閉じる' : '評価記録をまとめる'}
          </button>
        </div>
        <div className="recipe-import">
          <button
            className="secondary-button"
            aria-expanded={castingOpen}
            aria-controls="casting-workspace"
            onClick={() => setCastingOpen(!castingOpen)}
          >
            {castingOpen ? '製品横断の比較を閉じる' : 'VOICEVOX・AivisSpeech・ElevenLabsを比較する'}
          </button>
        </div>
        <div id="casting-workspace">
          <CastingWorkspace
            open={castingOpen}
            disabled={disabled}
            profile={profile}
            characterInput={profileInput}
          />
        </div>
        <div hidden={!evaluationOpen}>
          <EvaluationWorkbench currentEvaluations={evaluations} />
        </div>
        {notice && (
          <p className="recipe-notice" role="status">
            {notice}
          </p>
        )}
        {settingsOpen && (
          <section className="connection-panel" aria-label="接続設定">
            <div className="section-heading">
              <div>
                <span className="eyebrow">LOCAL FIRST</span>
                <h2>解析・試聴の接続</h2>
              </div>
              <button
                className="icon-button"
                onClick={() => setSettingsOpen(false)}
                aria-label="接続設定を閉じる"
              >
                <X size={18} />
              </button>
            </div>
            <p>
              手動モードは設定不要です。AI解析と試聴を使うときは、次のサービスを準備してください。
            </p>
            <div className="connection-grid">
              <div>
                <strong>
                  <span
                    className={`status-dot ${caps?.ollama.ready || caps?.ollama.textReady ? 'online' : ''}`}
                  />
                  Ollama
                </strong>
                <p>
                  {caps?.ollama.textReady && !caps.ollama.ready
                    ? '設定テキストからの演出案を利用できます（画像入力は未対応）'
                    : caps?.ollama.detail || '接続を確認中'}
                </p>
                <code>ollama pull gemma3:4b</code>
                <small>
                  モデル名は .env の OLLAMA_MODEL で変更できます。クラウドモデルは対象外です。
                </small>
              </div>
              <div>
                <strong>
                  <span className={`status-dot ${caps?.openai.ready ? 'online' : ''}`} />
                  OpenAI
                </strong>
                <p>
                  {caps?.openai.ready
                    ? 'APIキー設定済み（接続・利用権限は未検証）'
                    : 'サーバーの .env にAPIキーを設定'}
                </p>
                <code>OPENAI_API_KEY=…</code>
                <small>
                  モデル: {caps?.openai.model || 'gpt-4.1-mini'}
                  。API利用料はご自身のアカウントに発生します。
                </small>
              </div>
              <div>
                <strong>
                  <span className={`status-dot ${caps?.anthropic?.ready ? 'online' : ''}`} />
                  Anthropic（Claude）
                </strong>
                <p>
                  {caps?.anthropic?.ready
                    ? 'APIキー設定済み（接続・利用権限は未検証）'
                    : 'サーバーの .env にAPIキーを設定'}
                </p>
                <code>ANTHROPIC_API_KEY=…</code>
                <small>
                  モデル: {caps?.anthropic?.model || defaultAnthropicModel}
                  。ANTHROPIC_MODELで変更できます。設定後はサーバーを再起動してください。API利用料はご自身のアカウントに発生します。
                </small>
              </div>
              <div>
                <strong>
                  <span className={`status-dot ${caps?.gemini?.ready ? 'online' : ''}`} />
                  Google（Gemini）
                </strong>
                <p>
                  {caps?.gemini?.ready
                    ? 'APIキー設定済み（接続・利用権限は未検証）'
                    : 'サーバーの .env にAPIキーを設定'}
                </p>
                <code>GEMINI_API_KEY=…</code>
                <small>
                  モデル: {caps?.gemini?.model || defaultGeminiModel}
                  。GEMINI_MODELで変更できます。設定後はサーバーを再起動してください。利用枠・料金はご自身のGoogle
                  APIプロジェクトに従います。
                </small>
              </div>
              <div>
                <strong>
                  <span className={`status-dot ${caps?.deepseek?.ready ? 'online' : ''}`} />
                  DeepSeek
                </strong>
                <p>
                  {caps?.deepseek?.ready
                    ? 'APIキー設定済み（接続・利用権限は未検証）'
                    : 'サーバーの .env にAPIキーを設定'}
                </p>
                <code>DEEPSEEK_API_KEY=…</code>
                <small>
                  モデル: {caps?.deepseek?.model || defaultDeepseekModel}
                  。DEEPSEEK_MODELで変更できます。設定後はサーバーを再起動してください。API利用料はご自身のアカウントに発生します。
                </small>
              </div>
              <div>
                <strong>
                  <span className={`status-dot ${caps?.voicevox.ready ? 'online' : ''}`} />
                  VOICEVOX
                </strong>
                <p>{caps?.voicevox.detail || '接続を確認中'}</p>
                <code>127.0.0.1:50021</code>
                <small>
                  このコンピューターでVOICEVOXを起動すると、対応する話者を試聴できます。
                </small>
              </div>
              <div>
                <strong>AivisSpeech</strong>
                <p>「VOICEVOX・AivisSpeech・ElevenLabsを比較する」から接続を確認</p>
                <code>127.0.0.1:10101</code>
                <small>
                  AivisSpeechを起動してください。接続先は.envのAIVIS_BASE_URLで変更できます。設定後はサーバーを再起動してください。
                </small>
              </div>
            </div>
            <button className="text-button" onClick={() => void refresh()} disabled={checking}>
              <RefreshCw size={14} className={checking ? 'spin' : ''} />
              接続を再確認
            </button>
          </section>
        )}
        {error && (
          <div className="error-banner" role="alert">
            <CircleHelp size={19} />
            <span>{error}</span>
            {mode === 'deepseek' && error.startsWith('DeepSeekの') && (
              <button
                className="text-button"
                onClick={() => void analyze()}
                disabled={busy !== null}
              >
                手動で再試行
              </button>
            )}
            <button
              className="icon-button"
              onClick={() => setError('')}
              aria-label="エラーを閉じる"
            >
              <X size={17} />
            </button>
          </div>
        )}
        <div className="workspace" id="workspace" tabIndex={-1}>
          <aside className="input-column">
            <section className="panel image-panel">
              <div className="section-heading">
                <h2>
                  <span className="step">01</span>キャラクターを指定
                </h2>
                <span className="muted-tag">
                  {inputMode === 'text' ? '画像不要' : 'PNG / JPG / WebP'}
                </span>
              </div>
              <fieldset className="input-source-picker" disabled={disabled}>
                <legend className="field-label">入力するもの</legend>
                {(
                  [
                    { value: 'image', label: '画像と設定' },
                    { value: 'text', label: '設定テキストのみ' },
                  ] as const
                ).map((item) => (
                  <label key={item.value}>
                    <input
                      type="radio"
                      name="input-source"
                      value={item.value}
                      checked={inputMode === item.value}
                      onChange={() => {
                        setInputMode(item.value);
                        setVisualCorrection('');
                        setConsent(false);
                        setError('');
                      }}
                    />
                    {item.label}
                  </label>
                ))}
              </fieldset>
              <div hidden={inputMode !== 'image'}>
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  onChange={(event) => void loadImage(event.target.files?.[0])}
                  className="visually-hidden"
                  id="character-image"
                  disabled={disabled}
                />
                <div
                  className={`upload-zone ${image ? 'has-image' : ''} ${dragging ? 'dragging' : ''}`}
                  onDragOver={(event) => {
                    event.preventDefault();
                    if (!disabled) setDragging(true);
                  }}
                  onDragLeave={() => setDragging(false)}
                  onDrop={(event) => {
                    event.preventDefault();
                    setDragging(false);
                    if (!disabled) void loadImage(event.dataTransfer.files[0]);
                  }}
                >
                  {image ? (
                    <>
                      <img src={image.url} alt="選択した人物またはキャラクターの画像" />
                      <div className="image-toolbar">
                        <span>{image.name}</span>
                        <button
                          className="icon-button"
                          disabled={disabled}
                          aria-label="画像を削除"
                          onClick={() => {
                            ++imageGeneration.current;
                            setImage(null);
                            setAnalysis(null);
                            setHasResults(false);
                            clearAudio();
                          }}
                        >
                          <X size={16} />
                        </button>
                      </div>
                      <button
                        className="replace-image"
                        disabled={disabled}
                        onClick={() => fileRef.current?.click()}
                      >
                        <ImagePlus size={15} />
                        画像を変更
                      </button>
                    </>
                  ) : (
                    <button
                      className="upload-button"
                      onClick={() => fileRef.current?.click()}
                      disabled={disabled}
                    >
                      <span className="upload-symbol">
                        {loadingImage ? (
                          <LoaderCircle size={29} className="spin" />
                        ) : (
                          <ImagePlus size={29} strokeWidth={1.4} />
                        )}
                      </span>
                      <strong>キャラクターを、ここに。</strong>
                      <span>画像をドロップ、またはクリックして選択</span>
                      <small>8MBまで · 25メガピクセル以下の静止画</small>
                    </button>
                  )}
                </div>
                <p className="privacy-note">
                  <span className="tiny-dot" />
                  画像はこのアプリのディスクには保存しません。
                </p>
              </div>
              <label className="field-label" htmlFor="character-setting">
                キャラクター設定{' '}
                <span>
                  {inputMode === 'text' && mode !== 'manual' ? '必須' : '任意'}・2000文字まで
                </span>
              </label>
              <textarea
                id="character-setting"
                rows={6}
                maxLength={2000}
                value={characterText}
                disabled={disabled}
                onChange={(event) => {
                  setCharacterText(event.target.value);
                  setConsent(false);
                }}
                placeholder="例：図書館で旅人を案内する司書。穏やかだが芯が強い。丁寧な言葉遣いで、低めの声でゆっくり話す。"
              />
              <p className="footnote">
                役柄・性格・背景・話し方など、作者の設定を書きます。AIを選ぶと、この設定から声の演出案を作れます。
              </p>
            </section>
            <section className="panel direction-panel">
              <div className="section-heading">
                <h2>
                  <span className="step">02</span>声の方向を決める
                </h2>
              </div>
              <fieldset className="mode-picker" disabled={disabled}>
                <legend className="field-label">提案の作り方</legend>
                {(
                  [
                    { id: 'manual', label: '手動', hint: '設定不要' },
                    { id: 'ollama', label: 'Ollama', hint: 'ローカルAI' },
                    { id: 'openai', label: 'OpenAI', hint: '外部API' },
                    { id: 'anthropic', label: 'Claude', hint: 'Anthropic API' },
                    { id: 'gemini', label: 'Gemini', hint: 'Google API' },
                    { id: 'deepseek', label: 'DeepSeek', hint: 'DeepSeek API' },
                  ] as const
                ).map((item) => (
                  <label key={item.id} className={mode === item.id ? 'active' : ''}>
                    <input
                      type="radio"
                      name="mode"
                      value={item.id}
                      checked={mode === item.id}
                      onChange={() => {
                        setMode(item.id);
                        setConsent(false);
                        setError('');
                      }}
                    />
                    <span>{item.label}</span>
                    <small>{item.hint}</small>
                  </label>
                ))}
              </fieldset>
              {mode === 'manual' ? (
                <p className="mode-note">
                  下のスライダーから候補を探します。
                  <br />
                  手動モードでは画像・キャラクター設定を解析・送信しません。設定の意図は4軸に手動で反映してください。
                </p>
              ) : (
                <>
                  <p className="mode-note">
                    {mode === 'ollama'
                      ? `${sentData}をこのPCのOllamaへ送信し、声の演出案を作ります。`
                      : `${sentData}を${providerName} APIへ送信します。APIキーはサーバー内で管理します。`}
                  </p>
                  <label className="field-label" htmlFor="direction">
                    演出の補足 <span>任意</span>
                  </label>
                  <textarea
                    id="direction"
                    value={direction}
                    maxLength={1000}
                    onChange={(event) => {
                      setDirection(event.target.value);
                      setConsent(false);
                    }}
                    disabled={disabled}
                    placeholder="例：静かな案内役。低めの声で、丁寧に話してほしい。"
                    rows={3}
                  />
                  {externalProvider && (
                    <label className="consent">
                      <input
                        type="checkbox"
                        checked={consent}
                        disabled={disabled}
                        onChange={(event) => setConsent(event.target.checked)}
                      />
                      <span>
                        {sentData}を{providerName}
                        に送信することに同意する（API利用料がかかる場合があります）
                      </span>
                    </label>
                  )}
                  {mode === 'deepseek' && (
                    <small>
                      解析結果の形式が合わない場合は自動で1回再試行します。再試行分にもAPI利用料がかかる場合があります。
                    </small>
                  )}
                  {!providerReady && (
                    <div className="setup-note">
                      {checking ? '接続を確認しています…' : '接続の準備が必要です。'}
                      <button className="text-button" onClick={() => setSettingsOpen(true)}>
                        接続設定を開く
                        <ChevronRight size={13} />
                      </button>
                    </div>
                  )}
                </>
              )}
              <div className="profile-sliders">
                {axes.map((axis) => (
                  <div className="profile-control" key={axis}>
                    <div className="control-heading">
                      <label htmlFor={`profile-${axis}`}>{axisLabels[axis]}</label>
                      <HelpTip label={axisLabels[axis]}>{axisHelp[axis]}</HelpTip>
                      <output htmlFor={`profile-${axis}`}>{Math.round(profile[axis])}</output>
                    </div>
                    <input
                      id={`profile-${axis}`}
                      type="range"
                      aria-description={axisHelp[axis]}
                      min={0}
                      max={100}
                      value={profile[axis]}
                      disabled={disabled || (mode !== 'manual' && !hasResults)}
                      onChange={(event) => {
                        setProfile((current) => ({
                          ...current,
                          [axis]: Number(event.target.value),
                        }));
                        if (hasResults) setEdited(true);
                      }}
                    />
                    <div className="range-ends">
                      <span>{ends[axis][0]}</span>
                      <span>{ends[axis][1]}</span>
                    </div>
                  </div>
                ))}
              </div>
              <button
                className="primary-button"
                onClick={() => void analyze()}
                disabled={
                  disabled ||
                  (mode !== 'manual' &&
                    ((inputMode === 'image' ? !image : !characterText.trim()) ||
                      !providerReady ||
                      (externalProvider && !consent)))
                }
              >
                {busy === 'analysis' ? (
                  <>
                    <LoaderCircle size={17} className="spin" />
                    演出案を作成しています…
                  </>
                ) : (
                  <>
                    <Sparkles size={17} />
                    {mode === 'manual'
                      ? 'このイメージで声を探す'
                      : inputMode === 'image'
                        ? '画像から声の演出案を作る'
                        : '設定から声の演出案を作る'}
                    <ArrowRight size={17} />
                  </>
                )}
              </button>
              {busy && (
                <button
                  className="text-button cancel"
                  onClick={() => {
                    requestRef.current?.abort();
                    setBusy(null);
                  }}
                >
                  待機を中止する
                </button>
              )}
              {mode !== 'manual' && (
                <small className="footnote">
                  解析前の希望は補足欄へ。解析後はスライダーで調整できます。補足の変更は再解析で反映されます。
                </small>
              )}
            </section>
          </aside>
          <section className="results-column" ref={resultsRef} aria-label="声の候補">
            {!hasResults ? (
              <section className="empty-state">
                <div className="empty-art" aria-hidden="true">
                  <span className="orbit orbit-one" />
                  <span className="orbit orbit-two" />
                  <div className="empty-wave">
                    <AudioLines size={66} strokeWidth={1.1} />
                  </div>
                  <span className="floating-note note-one">穏やか</span>
                  <span className="floating-note note-two">凛とした</span>
                  <span className="floating-note note-three">軽やか</span>
                </div>
                <span className="eyebrow">FIND THEIR VOICE</span>
                <h2>まだ声のない、その物語に。</h2>
                <p>
                  画像やキャラクター設定から演出を考えたり、好みの声から探したり。
                  <br />
                  既存の音声ソフトで使える、声づくりの出発点を見つけましょう。
                </p>
                <div className="presets">
                  <span className="field-label">まずは、こんな声から</span>
                  {presets.map((preset, index) => (
                    <button
                      key={preset.name}
                      onClick={() => manualSearch(preset.profile)}
                      disabled={disabled}
                    >
                      <VoiceMark color={['#6d887b', '#bd986b', '#a08ba5'][index]} small />
                      <span>
                        <strong>{preset.name}</strong>
                        <small>{preset.note}</small>
                      </span>
                      <ArrowRight size={16} />
                    </button>
                  ))}
                </div>
                <div className="catalog-note">
                  <span>{voices.length} VOICES</span>
                  <i />
                  VOICEVOX · COEIROINK · A.I.VOICE2
                </div>
              </section>
            ) : (
              <>
                <div className="result-header">
                  <div>
                    <span className="eyebrow">YOUR VOICE DIRECTION</span>
                    <h2>
                      {analysis ? 'このイメージに、こんな声を。' : 'あなたの演出に、近い声。'}
                    </h2>
                  </div>
                  <span className="source-badge">
                    {source === 'manual'
                      ? '手動で作成'
                      : `${providerLabels[source]}で解析${profileInput?.mode === 'text' ? '（設定テキスト）' : ''}`}
                    {edited ? '・調整済み' : ''}
                  </span>
                </div>
                {inputChanged && (
                  <p className="input-change-note" role="status">
                    入力した設定が、現在の声の方向を作ったときから変わっています。反映するには
                    {mode === 'manual' ? '4軸を調整して検索' : '演出案を再作成'}
                    してください。保存には編集中の設定も含めます。
                  </p>
                )}
                {analysis && (
                  <div className="analysis-card">
                    <Sparkles size={19} />
                    <div>
                      <p>{analysis.summary}</p>
                      <small>
                        {profileInput?.mode === 'text'
                          ? '作者の設定からの要点'
                          : '画像の視覚的な要素'}
                      </small>
                      <div className="cue-tags">
                        {analysis.cues.map((cue, index) => (
                          <span key={index}>{cue}</span>
                        ))}
                      </div>
                      <small>声の演出案：{analysis.delivery}</small>
                      {profileInput?.mode === 'image' && (
                        <div className="visual-correction">
                          <label htmlFor="visual-correction">画像の説明に誤りがある場合</label>
                          <textarea
                            id="visual-correction"
                            value={visualCorrection}
                            maxLength={300}
                            rows={2}
                            disabled={disabled}
                            placeholder="例：耳元に端末は付いていません。頬の白い線は装飾です。"
                            onChange={(event) => setVisualCorrection(event.target.value)}
                          />
                          <button
                            className="text-button"
                            onClick={applyVisualCorrection}
                            disabled={disabled || !visualCorrection.trim()}
                          >
                            訂正を設定に反映
                          </button>
                          <small>
                            設定を確認してから再解析してください。外部APIには再度の同意が必要です。
                          </small>
                        </div>
                      )}
                    </div>
                  </div>
                )}
                <CharacterContext input={profileInput ?? undefined} />
                <div className="filters">
                  <span>
                    <span className="step">03</span>
                    <strong>声の候補</strong>
                    <small>{recommendations.length}件</small>
                  </span>
                  <div>
                    <label className="visually-hidden" htmlFor="engine-filter">
                      ソフトで絞り込む
                    </label>
                    <select
                      id="engine-filter"
                      disabled={disabled}
                      value={preferences.engine}
                      onChange={(event) =>
                        setPreferences((current) => ({
                          ...current,
                          engine: event.target.value as Engine | 'all',
                        }))
                      }
                    >
                      <option value="all">すべてのソフト</option>
                      <option>VOICEVOX</option>
                      <option>COEIROINK</option>
                      <option>A.I.VOICE2</option>
                    </select>
                    <label className="free-filter">
                      <input
                        type="checkbox"
                        checked={preferences.budget === 'free'}
                        disabled={disabled}
                        onChange={(event) =>
                          setPreferences((current) => ({
                            ...current,
                            budget: event.target.checked ? 'free' : 'all',
                          }))
                        }
                      />
                      無料のみ
                    </label>
                    <label className="free-filter">
                      <input
                        type="checkbox"
                        checked={availableOnly}
                        disabled={disabled}
                        onChange={(event) => setAvailableOnly(event.target.checked)}
                      />
                      試聴可能のみ
                    </label>
                  </div>
                </div>
                <div className="availability-summary" role="status" aria-live="polite">
                  <span>
                    VOICEVOX：
                    {checking
                      ? '話者・スタイルを確認中'
                      : caps?.voicevox.ready
                        ? `試聴可能 ${voicevoxVoices.filter((voice) => availability[voice.id] === 'available').length} / ${voicevoxVoices.length}候補`
                        : '未接続'}
                    {!checking && caps?.voicevox.checkedAt && (
                      <>（確認：{new Date(caps.voicevox.checkedAt).toLocaleTimeString('ja-JP')}）</>
                    )}
                  </span>
                  <button
                    className="text-button"
                    disabled={checking || disabled}
                    onClick={() => void refresh()}
                  >
                    <RefreshCw size={14} className={checking ? 'spin' : ''} />
                    接続を再確認
                  </button>
                </div>
                <p className="score-note">
                  近さの指標は声の演出に関する独自の目安です。本人の声の一致率を表すものではありません。
                </p>
                {!comparisonIds && (
                  <button
                    className="secondary-button compare-start"
                    disabled={disabled}
                    onClick={startComparison}
                  >
                    2候補を比較する
                  </button>
                )}
                {comparisonIds && (
                  <ComparisonPanel
                    contextKey={JSON.stringify([
                      comparisonIds,
                      text,
                      profile,
                      comparisonIds.map(getRecipe),
                    ])}
                    voices={voicevoxVoices}
                    ids={comparisonIds}
                    text={text}
                    disabled={disabled}
                    availability={availability}
                    availableOnly={availableOnly}
                    generating={busy === 'audio'}
                    evaluations={evaluations}
                    getRecipe={getRecipe}
                    getAudio={getAudio}
                    onPairChange={setComparisonIds}
                    onTextChange={setText}
                    onRecipeChange={changeRecipe}
                    onGenerate={() => void preview(comparisonIds)}
                    onRecord={recordEvaluation}
                    selectedId={selected?.voice.id ?? ''}
                  />
                )}
                {recommendations.length === 0 ? (
                  <div className="no-results">
                    <Mic2 size={28} />
                    <h3>この条件の候補はありません</h3>
                    <p>
                      {availableOnly
                        ? 'VOICEVOXの接続・音声ライブラリを確認するか、「試聴可能のみ」やソフトの条件を変更してください。'
                        : 'ソフトまたは「無料のみ」の条件を変更してください。'}
                    </p>
                    <button
                      className="secondary-button"
                      onClick={() => {
                        setPreferences({ engine: 'all', budget: 'all' });
                        setAvailableOnly(false);
                      }}
                    >
                      絞り込みをリセット
                    </button>
                  </div>
                ) : (
                  <div className="result-workbench">
                    <div className="voice-list">
                      {recommendations.map((item, index) => (
                        <button
                          className={`voice-card ${selected?.voice.id === item.voice.id ? 'selected' : ''}`}
                          key={item.voice.id}
                          disabled={disabled}
                          aria-pressed={selected?.voice.id === item.voice.id}
                          onClick={() => {
                            setSelectedId(item.voice.id);
                            if (window.innerWidth < 700)
                              setTimeout(
                                () =>
                                  detailRef.current?.scrollIntoView({
                                    behavior: 'smooth',
                                    block: 'start',
                                  }),
                                50,
                              );
                          }}
                        >
                          <div className="voice-card-top">
                            <span className="rank">{String(index + 1).padStart(2, '0')}</span>
                            <span className="engine-label">{item.voice.engine}</span>
                            {selected?.voice.id === item.voice.id && <Check size={14} />}
                          </div>
                          <div className="voice-card-main">
                            <VoiceMark color={item.voice.color} small />
                            <div>
                              <h3>{item.voice.name}</h3>
                              <small>{item.voice.style}</small>
                            </div>
                          </div>
                          <AvailabilityBadge status={availability[item.voice.id]} />
                          <div className="voice-card-bottom">
                            <span>{item.voice.tags.slice(0, 2).join(' · ')}</span>
                            <span className="score">
                              近さ <b>{item.score}</b>
                            </span>
                          </div>
                        </button>
                      ))}
                    </div>
                    {selected && (
                      <section className="recipe-panel" ref={detailRef} aria-label="調声レシピ">
                        <div className="recipe-intro">
                          <div className="detail-heading">
                            <VoiceMark color={selected.voice.color} />
                            <div>
                              <span className="engine-label">{selected.voice.engine}</span>
                              <h3>{selected.voice.name}</h3>
                              <p>
                                {selected.voice.style}{' '}
                                <span>
                                  ／ {selected.voice.price === 'free' ? '無料ソフト' : '有料製品'}
                                </span>
                              </p>
                            </div>
                          </div>
                          <p className="voice-description">{selected.voice.description}</p>
                          <AvailabilityBadge status={availability[selected.voice.id]} />
                          <p className="catalog-provenance">
                            声の特徴は未校正の編集値です。実機での聴取評価は未実施です。
                            <br />
                            <a
                              href={selected.voice.provenance.sourceUrl}
                              target="_blank"
                              rel="noreferrer"
                            >
                              話者・スタイルの出典
                            </a>{' '}
                            ／ 確認日：{selected.voice.provenance.reviewedAt}
                          </p>
                          <div className="tags">
                            {selected.voice.tags.map((tag) => (
                              <span key={tag}>{tag}</span>
                            ))}
                          </div>
                          <div className="matching-reasons">
                            {selected.reasons.map((reason) => (
                              <span key={reason}>
                                <Check size={12} />
                                {reason}
                              </span>
                            ))}
                          </div>
                        </div>
                        <div className="recipe-body">
                          <div className="section-heading">
                            <h4>
                              <SlidersHorizontal size={15} />
                              {recipe ? '調声レシピ' : '調声ガイド'}
                            </h4>
                            <HelpTip label={recipe ? '調声レシピ' : '調声ガイド'}>
                              {recipe
                                ? '調整値は選択中の話者の試聴に使います。「提案値に戻す」で初期提案へ戻せます。JSON保存はVoice Atlasの記録形式です。'
                                : '設定手順を参考に、選んだソフトで調整してください。このソフトの数値設定とアプリ内試聴には対応していません。'}
                            </HelpTip>
                            {recipe && (
                              <button
                                className="text-button"
                                disabled={disabled}
                                onClick={() => {
                                  setRecipes((current) => {
                                    const next = { ...current };
                                    delete next[selected.voice.id];
                                    return next;
                                  });
                                }}
                              >
                                提案値に戻す
                              </button>
                            )}
                          </div>
                          <p className="recipe-note">
                            {recipe
                              ? 'アプリ独自の提案値です。標準設定と聴き比べて仕上げてください。'
                              : 'このソフトは手動調整の方向を提案します。数値設定とアプリ内試聴は未対応です。'}
                          </p>
                          {recipe && (
                            <RecipeControls
                              recipe={recipe}
                              disabled={disabled}
                              onChange={(key, value) => {
                                changeRecipe(selected.voice.id, { ...recipe!, [key]: value });
                              }}
                            />
                          )}
                          <details className="guide-details" open={!recipe}>
                            <summary>
                              ソフトでの設定手順
                              <ChevronRight size={14} />
                            </summary>
                            <ol>
                              {selected.guide.map((step, index) => (
                                <li key={index}>{step}</li>
                              ))}
                            </ol>
                          </details>
                          {recipe && (
                            <div className="audition">
                              <label htmlFor="preview-text" className="field-label">
                                <Volume2 size={15} />
                                この設定で試聴する<span>300文字まで</span>
                              </label>
                              <textarea
                                id="preview-text"
                                rows={3}
                                maxLength={300}
                                value={text}
                                disabled={disabled}
                                onChange={(event) => setText(event.target.value)}
                              />
                              <button
                                className="secondary-button audition-button"
                                onClick={() => void preview()}
                                disabled={
                                  disabled ||
                                  availability[selected.voice.id] !== 'available' ||
                                  !text.trim()
                                }
                              >
                                {busy === 'audio' ? (
                                  <LoaderCircle className="spin" size={16} />
                                ) : (
                                  <Volume2 size={16} />
                                )}
                                VOICEVOXで音声を生成
                              </button>
                              <AvailabilityHelp status={availability[selected.voice.id]} />
                              {audioUrl && (
                                <div className="audio-result">
                                  <small>{audioLabel} · 現在の設定</small>
                                  <audio
                                    controls
                                    src={audioUrl}
                                    aria-label={`${audioLabel}の試聴`}
                                    onPlay={pauseOtherAudio}
                                  />
                                  <a
                                    href={audioUrl}
                                    download={`voice-atlas-${selected.voice.id}.wav`}
                                  >
                                    <ArrowDownToLine size={13} />
                                    WAVを保存
                                  </a>
                                </div>
                              )}
                            </div>
                          )}
                          <button
                            className="export-button"
                            onClick={exportRecipe}
                            disabled={disabled}
                          >
                            <ArrowDownToLine size={15} />
                            レシピをJSONで保存
                          </button>
                          <small className="footnote">
                            Voice
                            Atlas用の記録です。各ソフトへの直接インポート形式ではありません。画像は含みません。
                          </small>
                          <div className="official-links">
                            <a href={selected.voice.productUrl} target="_blank" rel="noreferrer">
                              公式サンプル・製品情報
                              <ExternalLink size={12} />
                            </a>
                            <a href={selected.voice.docsUrl} target="_blank" rel="noreferrer">
                              公式の使い方
                              <ExternalLink size={12} />
                            </a>
                            <a href={selected.voice.termsUrl} target="_blank" rel="noreferrer">
                              利用規約
                              <ExternalLink size={12} />
                            </a>
                          </div>
                          <div className="credit-note">
                            <strong>音声のクレジット参考表記</strong>
                            <code>{selected.voice.credit}</code>
                            <p>
                              公開・商用利用前に、ソフトと話者それぞれの最新の規約をご確認ください。無料で使えることと、用途の許諾は別です。
                            </p>
                            {selected.voice.termsNote && <p>{selected.voice.termsNote}</p>}
                          </div>
                        </div>
                      </section>
                    )}
                  </div>
                )}
              </>
            )}
          </section>
        </div>
        <section className="how-it-works" id="how-it-works">
          <div>
            <span className="eyebrow">A LITTLE GUIDE</span>
            <h2>声が見つかるまでの、3ステップ。</h2>
            <p>
              画像から実際の声や人物を特定する機能ではありません。
              <br />
              見た目と希望をヒントに、創作上の声の演出案を提案します。
            </p>
          </div>
          <ol>
            <li>
              <span>01</span>
              <div>
                <h3>イメージを用意する</h3>
                <p>
                  一人の人物・キャラクターの画像か、作者が書いた設定を用意します。手動なら、4軸の指定だけでも始められます。
                </p>
              </div>
            </li>
            <li>
              <span>02</span>
              <div>
                <h3>声の方向をつくる</h3>
                <p>AIで演出案を作成、またはスライダーで希望を指定。候補はいつでも調整できます。</p>
              </div>
            </li>
            <li>
              <span>03</span>
              <div>
                <h3>聴いて、仕上げる</h3>
                <p>公式サンプルやVOICEVOXで比較し、レシピを出発点にあなたらしい声へ。</p>
              </div>
            </li>
          </ol>
        </section>
      </main>
      <footer>
        <a href="/" className="footer-brand">
          voiceatlas<span>声を探す、創作のアトリエ。</span>
        </a>
        <div>
          v0.1.0 α <span>·</span> カタログ確認 {catalogReviewedAt}
          <br />
          <small>各音声ソフト・キャラクターの権利は、それぞれの権利者に帰属します。</small>
        </div>
      </footer>
    </>
  );
}
createRoot(document.getElementById('root')!).render(
  <ProjectProvider>
    <App />
  </ProjectProvider>,
);
