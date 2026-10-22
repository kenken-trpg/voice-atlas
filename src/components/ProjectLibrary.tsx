import { useEffect, useState } from 'react';
import {
  makeEmptyProject,
  maxProjectCount,
  projectSummary,
  readProjectLibrary,
  type ProjectLibraryAction,
  type VoiceProject,
} from '../../shared/project';

export function ProjectLibrary({
  disabled,
  onRequest,
  onRename,
}: {
  disabled: boolean;
  onRequest: (action: ProjectLibraryAction, project: VoiceProject) => void;
  onRename: (id: string, name: string) => void;
}) {
  const [projects, setProjects] = useState<VoiceProject[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [error, setError] = useState('');
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
  return (
    <section aria-label="作品ライブラリ" className="library-comparison">
      <h3>作品ライブラリ</h3>
      <p>最大{maxProjectCount}作品。作品ごとに声・配役・台本を分けて保存します。</p>
      {error && <p role="alert">{error}</p>}
      <button
        className="secondary-button"
        disabled={disabled || projects.length >= maxProjectCount}
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
              <p>更新：{new Date(project.updatedAt).toLocaleString('ja-JP')}</p>
              <div className="casting-actions">
                <button
                  className="secondary-button"
                  disabled={disabled || active === project.id}
                  onClick={() => onRequest({ type: 'select', id: project.id }, project)}
                >
                  この作品を開く
                </button>
                <button
                  className="secondary-button"
                  disabled={disabled}
                  onClick={() => {
                    setEditing(project.id);
                    setName(project.name);
                  }}
                >
                  作品名を変更
                </button>
                <button
                  className="secondary-button"
                  disabled={disabled || projects.length >= maxProjectCount}
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
                  disabled={disabled}
                  onClick={() => onRequest({ type: 'delete', id: project.id }, project)}
                >
                  この作品を削除
                </button>
              </div>
              {editing === project.id && (
                <div>
                  <label>
                    変更後の作品名
                    <input
                      aria-label="変更後の作品名"
                      value={name}
                      maxLength={100}
                      disabled={disabled}
                      onChange={(e) => setName(e.target.value)}
                    />
                  </label>
                  <button
                    className="secondary-button"
                    disabled={disabled || !name.trim()}
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
