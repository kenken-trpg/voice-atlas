import React, { useEffect, useMemo, useRef, useState } from 'react';
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
  type Provider,
  recipeFields,
  type Analysis,
  type Capabilities,
  type Engine,
  type Preferences,
  type Profile,
  type Recipe,
  type Recommendation,
} from '../shared/schema';
import { catalogReviewedAt, voices } from '../shared/catalog';
import { recommend } from '../shared/recommend';
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
async function jsonRequest<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || '処理に失敗しました。もう一度お試しください。');
  return data as T;
}
function download(name: string, content: string, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function VoiceMark({ color, small = false }: { color: string; small?: boolean }) {
  return (
    <span
      className={`voice-mark ${small ? 'small' : ''}`}
      style={{ '--voice-color': color } as React.CSSProperties}
      aria-hidden="true"
    >
      <i />
      <i />
      <i />
      <i />
      <i />
    </span>
  );
}
function App() {
  const [image, setImage] = useState<ImageData | null>(null);
  const [mode, setMode] = useState<Mode>('manual');
  const [consent, setConsent] = useState(false);
  const [direction, setDirection] = useState('');
  const [profile, setProfile] = useState<Profile>({ ...neutralProfile });
  const [preferences, setPreferences] = useState<Preferences>({ engine: 'all', budget: 'all' });
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [source, setSource] = useState<Mode>('manual');
  const [edited, setEdited] = useState(false);
  const [hasResults, setHasResults] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [recipe, setRecipe] = useState<Recipe | null>(null);
  const [text, setText] = useState(defaultText);
  const [caps, setCaps] = useState<Capabilities | null>(null);
  const [checking, setChecking] = useState(false);
  const [busy, setBusy] = useState<'analysis' | 'audio' | null>(null);
  const [loadingImage, setLoadingImage] = useState(false);
  const [error, setError] = useState('');
  const [audioUrl, setAudioUrl] = useState('');
  const [audioLabel, setAudioLabel] = useState('');
  const [dragging, setDragging] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const imageGeneration = useRef(0);
  const requestRef = useRef<AbortController | null>(null);
  const resultsRef = useRef<HTMLElement>(null);
  const detailRef = useRef<HTMLElement>(null);
  const externalProvider = mode === 'openai' || mode === 'anthropic';
  const providerName = mode === 'manual' ? '手動' : providerLabels[mode];

  async function refresh() {
    setChecking(true);
    try {
      setCaps(await jsonRequest<Capabilities>('/api/capabilities'));
    } catch {
      setError('接続状態を確認できませんでした。アプリのサーバーを確認してください。');
    } finally {
      setChecking(false);
    }
  }
  useEffect(() => {
    void refresh();
    return () => requestRef.current?.abort();
  }, []);
  useEffect(
    () => () => {
      if (audioUrl) URL.revokeObjectURL(audioUrl);
    },
    [audioUrl],
  );
  const recommendations = useMemo(() => recommend(profile, preferences), [profile, preferences]);
  const selected =
    recommendations.find((item) => item.voice.id === selectedId) || recommendations[0];
  const selectionKey = selected ? JSON.stringify([selected.voice.id, selected.recipe]) : '';
  useEffect(() => {
    setRecipe(selected?.recipe ? { ...selected.recipe } : null);
    setAudioUrl('');
  }, [selectionKey]);
  useEffect(() => {
    setAudioUrl('');
  }, [text, recipe]);

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
      setHasResults(false);
      setAudioUrl('');
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
    setEdited(false);
    setHasResults(true);
    setSelectedId(null);
    setError('');
    revealResults();
  }
  async function analyze() {
    if (mode === 'manual') {
      manualSearch();
      return;
    }
    if (!image) {
      setError('解析したい人物やキャラクターの画像を選んでください。');
      return;
    }
    if (externalProvider && !consent) {
      setError(`画像と補足の${providerName}への送信に同意してください。`);
      return;
    }
    const controller = new AbortController();
    requestRef.current = controller;
    setBusy('analysis');
    setError('');
    setAudioUrl('');
    try {
      const result = await jsonRequest<{ analysis: Analysis }>(
        '/api/analyze',
        { provider: mode, image: image.url, direction, consent },
        controller.signal,
      );
      if (!result.analysis.subjectFound) {
        setError(result.analysis.summary);
        return;
      }
      setAnalysis(result.analysis);
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
      setBusy(null);
    }
  }
  async function preview() {
    if (!selected || !recipe) return;
    const controller = new AbortController();
    requestRef.current = controller;
    setBusy('audio');
    setError('');
    setAudioUrl('');
    try {
      const response = await fetch('/api/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ voiceId: selected.voice.id, recipe, text }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || '音声を生成できませんでした。');
      }
      const blob = await response.blob();
      setAudioUrl(URL.createObjectURL(blob));
      setAudioLabel(`${selected.voice.name} / ${selected.voice.style}`);
    } catch (e) {
      if (!controller.signal.aborted)
        setError(e instanceof Error ? e.message : '音声を生成できませんでした。');
    } finally {
      setBusy(null);
    }
  }
  function exportRecipe() {
    if (!selected) return;
    download(
      `voice-atlas-${selected.voice.id}.json`,
      JSON.stringify(
        {
          format: 'voice-atlas-recipe',
          version: 1,
          createdAt: new Date().toISOString(),
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
        },
        null,
        2,
      ),
    );
  }
  const disabled = Boolean(busy) || loadingImage;
  const providerReady = mode === 'manual' || Boolean(caps?.[mode].ready);
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
                className={`status-dot ${caps?.ollama.ready || caps?.openai.ready || caps?.anthropic?.ready ? 'online' : ''}`}
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
                画像から、音声ソフトと調声のレシピへ。
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
                  <span className={`status-dot ${caps?.ollama.ready ? 'online' : ''}`} />
                  Ollama
                </strong>
                <p>{caps?.ollama.detail || '接続を確認中'}</p>
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
                  <span className={`status-dot ${caps?.voicevox.ready ? 'online' : ''}`} />
                  VOICEVOX
                </strong>
                <p>{caps?.voicevox.detail || '接続を確認中'}</p>
                <code>127.0.0.1:50021</code>
                <small>
                  このコンピューターでVOICEVOXを起動すると、対応する話者を試聴できます。
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
            <button
              className="icon-button"
              onClick={() => setError('')}
              aria-label="エラーを閉じる"
            >
              <X size={17} />
            </button>
          </div>
        )}
        <div className="workspace" id="workspace">
          <aside className="input-column">
            <section className="panel image-panel">
              <div className="section-heading">
                <h2>
                  <span className="step">01</span>イメージを選ぶ
                </h2>
                <span className="muted-tag">PNG / JPG / WebP</span>
              </div>
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
                          setAudioUrl('');
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
                  手動モードでは画像を解析・送信しません。
                </p>
              ) : (
                <>
                  <p className="mode-note">
                    {mode === 'ollama'
                      ? '画像と補足をこのPCのOllamaへ送信し、声の演出案を作ります。'
                      : `画像と補足を${providerName} APIへ送信します。APIキーはサーバー内で管理します。`}
                  </p>
                  <label className="field-label" htmlFor="direction">
                    演出の補足 <span>任意</span>
                  </label>
                  <textarea
                    id="direction"
                    value={direction}
                    maxLength={1000}
                    onChange={(event) => setDirection(event.target.value)}
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
                        画像と補足を{providerName}に送信することに同意する（API利用料がかかります）
                      </span>
                    </label>
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
                    <label htmlFor={`profile-${axis}`}>
                      {axisLabels[axis]}
                      <output>{Math.round(profile[axis])}</output>
                    </label>
                    <input
                      id={`profile-${axis}`}
                      type="range"
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
                    (!image || !providerReady || (externalProvider && !consent)))
                }
              >
                {busy === 'analysis' ? (
                  <>
                    <LoaderCircle size={17} className="spin" />
                    画像を解析しています…
                  </>
                ) : (
                  <>
                    <Sparkles size={17} />
                    {mode === 'manual' ? 'このイメージで声を探す' : '画像から声の演出案を作る'}
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
                  画像から演出を考えたり、好みの声から探したり。
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
                    {source === 'manual' ? '手動で作成' : `${providerLabels[source]}で解析`}
                    {edited ? '・調整済み' : ''}
                  </span>
                </div>
                {analysis && (
                  <div className="analysis-card">
                    <Sparkles size={19} />
                    <div>
                      <p>{analysis.summary}</p>
                      <div className="cue-tags">
                        {analysis.cues.map((cue, index) => (
                          <span key={index}>{cue}</span>
                        ))}
                      </div>
                      <small>{analysis.delivery}</small>
                    </div>
                  </div>
                )}
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
                  </div>
                </div>
                <p className="score-note">
                  近さの指標は声の演出に関する独自の目安です。本人の声の一致率を表すものではありません。
                </p>
                {recommendations.length === 0 ? (
                  <div className="no-results">
                    <Mic2 size={28} />
                    <h3>この条件の候補はありません</h3>
                    <p>ソフトまたは「無料のみ」の条件を変更してください。</p>
                    <button
                      className="secondary-button"
                      onClick={() => setPreferences({ engine: 'all', budget: 'all' })}
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
                            {recipe && (
                              <button
                                className="text-button"
                                disabled={disabled}
                                onClick={() => {
                                  setRecipe({ ...selected.recipe! });
                                  setAudioUrl('');
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
                            <div className="recipe-sliders">
                              {recipeFields.map((field) => (
                                <div className="recipe-control" key={field.key}>
                                  <label htmlFor={`recipe-${field.key}`} title={field.help}>
                                    {field.label}
                                    <output>
                                      {recipe[field.key].toFixed(2)}
                                      <small>{field.unit}</small>
                                    </output>
                                  </label>
                                  <input
                                    id={`recipe-${field.key}`}
                                    type="range"
                                    min={field.min}
                                    max={field.max}
                                    step={field.step}
                                    value={recipe[field.key]}
                                    disabled={disabled}
                                    aria-description={field.help}
                                    onChange={(event) => {
                                      setRecipe((current) =>
                                        current
                                          ? { ...current, [field.key]: Number(event.target.value) }
                                          : null,
                                      );
                                      setEdited(true);
                                    }}
                                  />
                                </div>
                              ))}
                            </div>
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
                                disabled={disabled || !caps?.voicevox.ready || !text.trim()}
                              >
                                {busy === 'audio' ? (
                                  <LoaderCircle className="spin" size={16} />
                                ) : (
                                  <Volume2 size={16} />
                                )}
                                VOICEVOXで音声を生成
                              </button>
                              {!caps?.voicevox.ready && (
                                <small className="footnote">
                                  このPCでVOICEVOXを起動し、接続設定で再確認してください。
                                </small>
                              )}
                              {audioUrl && (
                                <div className="audio-result">
                                  <small>{audioLabel} · 現在の設定</small>
                                  <audio
                                    controls
                                    src={audioUrl}
                                    aria-label={`${audioLabel}の試聴`}
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
                  一人の人物・キャラクターの画像を選びます。手動なら、画像なしでも始められます。
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
createRoot(document.getElementById('root')!).render(<App />);
