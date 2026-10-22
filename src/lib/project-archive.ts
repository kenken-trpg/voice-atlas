import { type ProjectArchive, projectArchiveLines } from '../../shared/project-archive';
import { type VoiceProject } from '../../shared/project';
import { scriptAudioKey } from '../../shared/script';
import { saveProjectArchiveAudio, deleteProjectAudio } from './script-audio-store';

// New namespace only: failed staging never modifies another project's audio.
// IndexedDB and localStorage cannot share a transaction. Publish settings last.
export async function restoreProjectArchive(
  archive: ProjectArchive,
  publish: (project: VoiceProject) => void,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const project = { ...archive.project, id: crypto.randomUUID() };
  const lines = new Map(projectArchiveLines(project).map((line) => [scriptAudioKey(line), line]));
  let staged = false;
  try {
    if (archive.audio.length) {
      await saveProjectArchiveAudio(
        project.id,
        archive.audio.map((item) => {
          const line = lines.get(item.key);
          if (!line || line.id !== item.lineId) throw new Error('音声と台本条件が一致しません。');
          return { line, blob: item.blob, audition: item.audition };
        }),
      );
      staged = true;
    }
    signal.throwIfAborted();
    publish(project);
    return project;
  } catch (cause) {
    if (staged) {
      try {
        await deleteProjectAudio(project.id);
      } catch {
        throw new Error('作品は切り替えていません。一時保存した音声の削除に失敗しました。');
      }
    }
    throw cause;
  }
}
