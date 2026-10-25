import { type ProjectArchive, projectArchiveLines } from '../../shared/project-archive';
import { type VoiceProject } from '../../shared/project';
import { scriptAudioKey } from '../../shared/script';
import { saveProjectArchiveAudio, deleteProjectAudio } from './script-audio-store';
import { irodoriCandidates } from '../../shared/irodori-candidates';
import { deleteIrodoriAudio, readIrodoriAudio, saveIrodoriAudio } from './irodori-audio-store';

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
  let newIrodoriHashes: string[] = [];
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
    if (archive.irodoriAudio.length) {
      const existing = await readIrodoriAudio();
      const names = new Map<string, string>(
        irodoriCandidates.flatMap((voice) =>
          voice.samples.map((sample) => [sample.sha256, sample.file] as const),
        ),
      );
      const missing = archive.irodoriAudio.filter((item) => !(item.sha256 in existing));
      if (missing.length) {
        await saveIrodoriAudio(
          missing.map(
            (item) => new File([item.blob], names.get(item.sha256)!, { type: 'audio/wav' }),
          ),
        );
        newIrodoriHashes = missing.map((item) => item.sha256);
      }
    }
    signal.throwIfAborted();
    publish(project);
    return project;
  } catch (cause) {
    let cleanupFailed = false;
    if (newIrodoriHashes.length) {
      try {
        await deleteIrodoriAudio(newIrodoriHashes);
      } catch {
        cleanupFailed = true;
      }
    }
    if (staged) {
      try {
        await deleteProjectAudio(project.id);
      } catch {
        cleanupFailed = true;
      }
    }
    if (cleanupFailed)
      throw new Error('作品は切り替えていません。一時保存した音声の削除に失敗しました。');
    throw cause;
  }
}
