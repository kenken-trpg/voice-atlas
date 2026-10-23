import { useEffect, useState } from 'react';
import {
  makeEmptyProject,
  maxProjectCount,
  projectSummary,
  readProjectLibrary,
  type ProjectLibraryAction,
  type VoiceProject,
} from '../../shared/project';
import { savedAudioChangedEvent } from '../lib/script-audio-events';
import { useProject } from '../lib/project-context';

type AudioUsage = { bytes: number; entries: number };
type AudioDeletion = AudioUsage & { id: string; name: string };
const formatMiB = (bytes: number) => (bytes / 1024 ** 2).toFixed(2);

export function ProjectLibrary({
  disabled,
  onRequest,
  onRename,
  onLockChange,
}: {
  disabled: boolean;
  onRequest: (action: ProjectLibraryAction, project: VoiceProject) => void;
  onRename: (id: string, name: string) => void;
  onLockChange: (locked: boolean) => void;
}) {
  const { ensureIdle } = useProject();
  const [projects, setProjects] = useState<VoiceProject[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [audioByProject, setAudioByProject] = useState<Map<
    string,
    { bytes: number; entries: number }
  > | null>(null);
  const [audioError, setAudioError] = useState(false);
  const [audioDeletion, setAudioDeletion] = useState<AudioDeletion | null>(null);
  const [deletingAudio, setDeletingAudio] = useState(false);
  const [deleteError, setDeleteError] = useState('');
  const [deleteNotice, setDeleteNotice] = useState('');
  const locked = disabled || deletingAudio;
  useEffect(() => onLockChange(deletingAudio), [deletingAudio, onLockChange]);
  useEffect(() => {
    function refresh() {
      try {
        const library = readProjectLibrary(localStorage);
        setProjects(library.projects);
        setActive(library.activeId);
        setError('');
      } catch {
        setError('作品一覧を読み込めませんでした。保存データは変更していません。');
      }
    }
    refresh();
    const timer = setInterval(refresh, 1000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    let disposed = false;
    let request = 0;
    async function refreshAudio() {
      const current = ++request;
      try {
        const { readSavedAudioByProject } = await import('../lib/script-audio-store');
        const usage = await readSavedAudioByProject();
        if (!disposed && current === request) {
          setAudioByProject(usage);
          setAudioError(false);
        }
      } catch {
        if (!disposed && current === request) {
          setAudioByProject(null);
          setAudioError(true);
        }
      }
    }
    void refreshAudio();
    const onChange = () => void refreshAudio();
    window.addEventListener(savedAudioChangedEvent, onChange);
    window.addEventListener('focus', onChange);
    const timer = setInterval(onChange, 5000);
    return () => {
      disposed = true;
      window.removeEventListener(savedAudioChangedEvent, onChange);
      window.removeEventListener('focus', onChange);
      clearInterval(timer);
    };
  }, []);
  async function confirmAudioDeletion() {
    if (!audioDeletion || locked) return;
    setDeletingAudio(true);
    setDeleteError('');
    setDeleteNotice('');
    try {
      ensureIdle();
      const project = readProjectLibrary(localStorage).projects.find(
        (item) => item.id === audioDeletion.id,
      );
      if (!project) {
        setAudioDeletion(null);
        throw new Error('対象の作品が一覧からなくなりました。');
      }
      const { readSavedAudioByProject, deleteProjectAudio, SavedAudioChangedError } =
        await import('../lib/script-audio-store');
      const fresh = await readSavedAudioByProject();
      const usage = fresh.get(audioDeletion.id) ?? { bytes: 0, entries: 0 };
      setAudioByProject(fresh);
      setAudioError(false);
      if (
        project.name !== audioDeletion.name ||
        usage.bytes !== audioDeletion.bytes ||
        usage.entries !== audioDeletion.entries
      ) {
        setAudioDeletion({ id: project.id, name: project.name, ...usage });
        setDeleteNotice(
          '作品名または保存音声量が変わりました。内容を確認してからもう一度削除してください。',
        );
        return;
      }
      if (!usage.entries) {
        setAudioDeletion(null);
        setDeleteNotice('この作品の保存音声はありません。');
        return;
      }
      try {
        await deleteProjectAudio(project.id, usage);
      } catch (cause) {
        if (!(cause instanceof SavedAudioChangedError)) throw cause;
        const changed = await readSavedAudioByProject();
        const latest = changed.get(project.id) ?? { bytes: 0, entries: 0 };
        setAudioByProject(changed);
        setAudioDeletion({ id: project.id, name: project.name, ...latest });
        setDeleteNotice('保存音声量が変わりました。内容を確認してからもう一度削除してください。');
        return;
      }
      setAudioDeletion(null);
      setDeleteNotice(
        `「${project.name}」の保存音声${usage.entries}行を削除しました。作品の設定と編集中の試聴音声は保持しています。`,
      );
    } catch (cause) {
      setDeleteError(
        cause instanceof Error && cause.message.length < 200
          ? cause.message
          : '保存音声を削除できませんでした。現在の音声は保持しています。',
      );
    } finally {
      setDeletingAudio(false);
    }
  }
  return (
    <section aria-label="作品ライブラリ" className="library-comparison">
      <h3>作品ライブラリ</h3>
      <p>
        最大{maxProjectCount}
        作品。作品ごとに声・配役・台本を分けて保存します。保存音声は作品ごとに確認して削除できます。
      </p>
      {error && <p role="alert">{error}</p>}
      {audioError && <p role="status">保存音声量を確認できません。作品の操作は続けられます。</p>}
      {deleteError && <p role="alert">{deleteError}</p>}
      {deleteNotice && <p role="status">{deleteNotice}</p>}
      <button
        className="secondary-button"
        disabled={locked || projects.length >= maxProjectCount}
        onClick={() => {
          const project = makeEmptyProject();
          onRequest({ type: 'open', project }, project);
        }}
      >
        新しい作品を作成
      </button>
      <label>
        作品を検索
        <input
          aria-label="作品ライブラリの検索"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </label>
      <p role="status">保存作品：{projects.length}件</p>
      <ol className="evaluation-history">
        {projects
          .filter((p) => p.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
          .map((project) => (
            <li key={project.id} aria-label={`保存作品 ${project.name}`}>
              <strong>
                {project.name}
                {active === project.id ? ' · 使用中' : ''}
              </strong>
              <p>{projectSummary(project)}</p>
              <p>
                保存音声：
                {audioByProject
                  ? `${formatMiB(audioByProject.get(project.id)?.bytes ?? 0)}MiB・${audioByProject.get(project.id)?.entries ?? 0}行`
                  : audioError
                    ? '確認できません'
                    : '確認中…'}
              </p>
              <p>更新：{new Date(project.updatedAt).toLocaleString('ja-JP')}</p>
              <div className="casting-actions">
                <button
                  className="secondary-button"
                  disabled={locked || active === project.id}
                  onClick={() => onRequest({ type: 'select', id: project.id }, project)}
                >
                  この作品を開く
                </button>
                <button
                  className="secondary-button"
                  disabled={locked}
                  onClick={() => {
                    setEditing(project.id);
                    setName(project.name);
                  }}
                >
                  作品名を変更
                </button>
                <button
                  className="secondary-button"
                  disabled={locked || projects.length >= maxProjectCount}
                  onClick={() => {
                    const now = new Date().toISOString();
                    const copy = {
                      ...structuredClone(project),
                      id: crypto.randomUUID(),
                      name: `${project.name.slice(0, 94)}（コピー）`,
                      createdAt: now,
                      updatedAt: now,
                    };
                    onRequest({ type: 'open', project: copy }, copy);
                  }}
                >
                  保存済みの作品を複製
                </button>
                <button
                  className="text-button"
                  disabled={locked}
                  onClick={() => onRequest({ type: 'delete', id: project.id }, project)}
                >
                  この作品を削除
                </button>
                <button
                  className="text-button"
                  disabled={locked || !audioByProject?.get(project.id)?.entries}
                  onClick={() => {
                    const usage = audioByProject?.get(project.id);
                    if (!usage?.entries) return;
                    setAudioDeletion({ id: project.id, name: project.name, ...usage });
                    setDeleteError('');
                    setDeleteNotice('');
                  }}
                >
                  保存音声を削除
                </button>
              </div>
              {audioDeletion?.id === project.id && (
                <div role="group" aria-label="作品の保存音声の削除確認">
                  <p>
                    「{audioDeletion.name}」の保存音声{audioDeletion.entries}行・
                    {formatMiB(audioDeletion.bytes)}
                    MiBを削除します。作品の設定・台本と編集中の試聴音声は保持します。
                  </p>
                  <button
                    className="secondary-button"
                    disabled={locked}
                    onClick={() => void confirmAudioDeletion()}
                  >
                    確認した保存音声を削除
                  </button>
                  <button
                    className="text-button"
                    disabled={locked}
                    onClick={() => setAudioDeletion(null)}
                  >
                    保存音声の削除をキャンセル
                  </button>
                </div>
              )}
              {editing === project.id && (
                <div>
                  <label>
                    変更後の作品名
                    <input
                      aria-label="変更後の作品名"
                      value={name}
                      maxLength={100}
                      disabled={locked}
                      onChange={(e) => setName(e.target.value)}
                    />
                  </label>
                  <button
                    className="secondary-button"
                    disabled={locked || !name.trim()}
                    onClick={() => {
                      onRename(project.id, name);
                      setEditing(null);
                    }}
                  >
                    作品名の変更を保存
                  </button>
                  <button className="text-button" onClick={() => setEditing(null)}>
                    名前の変更をキャンセル
                  </button>
                </div>
              )}
            </li>
          ))}
      </ol>
    </section>
  );
}
