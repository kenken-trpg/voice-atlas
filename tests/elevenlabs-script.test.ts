import { describe, expect, it } from 'vitest';
import { elevenLabsScriptFixture } from './fixtures/elevenlabs-script';
import { parseScript, serializeScript, scriptAudioKey, scriptCandidate } from '../shared/script';
import { planScriptCasting } from '../shared/script-casting';
import { createProjectArchive, parseProjectArchive } from '../shared/project-archive';
import { projectFixture } from './fixtures/project';
import { pcmWav } from './fixtures/wav';

describe('ElevenLabs script production', () => {
  it('assigns the chosen comparison voice to an unassigned speaker and round trips native settings', () => {
    const { script, assignments, cloud } = elevenLabsScriptFixture();
    const draft = {
      ...script,
      lines: script.lines.map((line) => ({
        ...line,
        character: line.assignment!.character,
        assignment: null,
      })),
    };
    const plan = planScriptCasting(
      draft,
      assignments,
      [{ character: '案内人', assignmentId: assignments[0].id }],
      false,
    );
    const saved = parseScript(serializeScript(plan.script));
    expect(scriptCandidate(saved.lines[0])).toEqual(cloud);
    expect(scriptCandidate(saved.lines[2])).toEqual(cloud);
    expect(saved.lines[1].assignment).toBeNull();
    expect(saved.lines[0].spokenText).toBe(script.lines[0].spokenText);
    expect(plan.audioChangedIds).toHaveLength(2);
  });
  it('invalidates cached audio for voice, model, each native setting and spoken text changes', () => {
    const { script } = elevenLabsScriptFixture();
    const line = script.lines[0];
    const key = scriptAudioKey(line);
    for (const change of [
      { modelId: 'other-model' },
      { stability: 0.1 },
      { similarityBoost: 0.1 },
      { style: 0.1 },
      { useSpeakerBoost: false },
      { seed: 43 },
    ]) {
      const changed = structuredClone(line);
      Object.assign(
        changed.assignment!.comparison.entries[0].evaluation.candidates[0].recipe,
        change,
      );
      expect(scriptAudioKey(changed)).not.toBe(key);
    }
    const changedVoice = structuredClone(line);
    const voice = changedVoice.assignment!.comparison.entries[0].evaluation.candidates[0].voice;
    if (voice.engine !== 'ElevenLabs') throw new Error('fixture');
    voice.voiceId = 'another_voice';
    expect(scriptAudioKey(changedVoice)).not.toBe(key);
    expect(scriptAudioKey({ ...line, spokenText: '異なる読み' })).not.toBe(key);
    expect(scriptAudioKey({ ...line, text: '表記の変更', character: '表示名の変更' })).toBe(key);
  });
  it('archives cloud audio with current generation provenance and original voice/model/settings', async () => {
    const { script, cloud, assignments } = elevenLabsScriptFixture();
    const project = projectFixture();
    project.documents.script = script;
    project.documents.castingBoard.assignments = assignments;
    const line = script.lines[0];
    const audio = [
      {
        lineId: line.id,
        key: scriptAudioKey(line),
        blob: new Blob([pcmWav([1, -1])]),
        audition: {
          generation: {
            engine: 'ElevenLabs' as const,
            engineVersion: null,
            checkedAt: project.createdAt,
            modelId: cloud.recipe.modelId,
            outputFormat: cloud.recipe.outputFormat,
            seed: cloud.recipe.seed,
          },
        },
      },
    ];
    const restored = await parseProjectArchive(await createProjectArchive(project, audio));
    expect(scriptCandidate(restored.project.documents.script!.lines[0])).toEqual(cloud);
    expect(restored.audio[0].audition).toEqual(audio[0].audition);
    expect(await restored.audio[0].blob.arrayBuffer()).toEqual(await audio[0].blob.arrayBuffer());
  });
});
