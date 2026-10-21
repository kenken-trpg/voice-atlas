import { describe, expect, it, vi } from 'vitest';
import { getAivisModelInfo } from '../server/tts/aivis-model-info';
import { safeModelLink, aivisModelInfoSchema, modelInfoChanged } from '../shared/aivis-model-info';
import { castingCandidateSchema, castingSessionSchema } from '../shared/casting';
import {
  castingEvaluationKey,
  makeCastingDataset,
  parseCastingEvaluationFile,
  mergeCastingEvaluations,
  castingEvaluationsCsv,
  resumeCastingEvaluation,
  filterCastingEvaluations,
  defaultCastingFilters,
} from '../shared/casting-dataset';
import {
  aivisModelsPayload,
  modelInfo,
  evaluationWithModelInfo,
  modelUuid,
  speakerUuid,
} from './fixtures/aivis-model-info';
import { makeCastingSession } from './fixtures/casting';

describe('AivisSpeech model metadata', () => {
  it('reads official model manifests and exposes only bounded whitelisted text', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(aivisModelsPayload()));
    const result = await getAivisModelInfo('http://127.0.0.1:10101', fetcher);
    expect(result.ready).toBe(true);
    expect(result.models).toHaveLength(2);
    expect(result.models[0]).toMatchObject({
      engine: 'AivisSpeech',
      source: '/aivm_models',
      modelUuid,
      modelName: '検証用モデル',
      modelVersion: '1.2.3',
      speakerUuid,
      licenseStatus: 'provided',
    });
    expect(result.models[0].links).toEqual([
      'https://example.com/terms',
      'https://example.com/creator',
    ]);
    expect(JSON.stringify(result)).not.toMatch(
      /file_path|do-not-expose|data:image|data:audio|voice_samples|is_loaded/,
    );
    expect(fetcher).toHaveBeenCalledWith(
      'http://127.0.0.1:10101/aivm_models',
      expect.objectContaining({ redirect: 'error', signal: expect.any(AbortSignal) }),
    );
  });
  it.each(['offline', 'http-error', 'invalid-json', 'invalid-type', 'oversized'])(
    'keeps metadata optional on %s',
    async (failure) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => {
        if (failure === 'offline') throw new Error('upstream private data');
        if (failure === 'http-error') return new Response('private', { status: 501 });
        if (failure === 'invalid-json') return new Response('broken');
        if (failure === 'oversized')
          return new Response('small', { headers: { 'Content-Length': String(9 * 1024 * 1024) } });
        return Response.json([]);
      });
      const result = await getAivisModelInfo('http://127.0.0.1:10101', fetcher);
      expect(result).toMatchObject({ ready: false, models: [] });
      expect(JSON.stringify(result)).not.toContain('private');
    },
  );
  it('does not interpret missing license text as permission, or cut off long terms silently', async () => {
    const missing = aivisModelsPayload();
    missing[modelUuid].manifest.license = '';
    const a = await getAivisModelInfo(
      'http://127.0.0.1:10101',
      vi.fn<typeof fetch>().mockResolvedValue(Response.json(missing)),
    );
    expect(a.models[0]).toMatchObject({ licenseStatus: 'not-provided', licenseText: null });
    const b = await getAivisModelInfo(
      'http://127.0.0.1:10101',
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(Response.json(aivisModelsPayload('利用条件'.repeat(4000)))),
    );
    expect(b.models[0]).toMatchObject({
      modelName: '検証用モデル',
      licenseStatus: 'omitted',
      licenseText: null,
    });
  });
  it('ignores malformed/mismatched/ambiguous manifests without following embedded links', async () => {
    const original = aivisModelsPayload();
    const another = structuredClone(original[modelUuid]);
    const id = '33333333-3333-4333-8333-333333333333';
    another.manifest.uuid = id;
    const response = await getAivisModelInfo(
      'http://127.0.0.1:10101',
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          Response.json({ ...original, [id]: another, invalid: { manifest: { uuid: 'bad' } } }),
        ),
    );
    expect(response.ready).toBe(true);
    expect(response.models).toEqual([]);
    const mismatch = await getAivisModelInfo(
      'http://127.0.0.1:10101',
      vi.fn<typeof fetch>().mockResolvedValue(Response.json({ [id]: original[modelUuid] })),
    );
    expect(mismatch.models).toEqual([]);
  });
  it.each([
    'javascript:alert(1)',
    'data:text/html,<script>',
    'file:///tmp/private',
    'https://user:pass@example.com/',
    'https://example.com/\nprivate',
  ])('rejects unsafe model link %s', (link) => {
    expect(safeModelLink(link)).toBeNull();
    expect(aivisModelInfoSchema.safeParse({ ...modelInfo(), links: [link] }).success).toBe(false);
  });
  it('extracts only HTTP/HTTPS references from plain policy text without fetching them', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json(
          aivisModelsPayload(
            '[規約](https://example.com/policy) ![画像](https://example.com/image.png) <script>alert(1)</script> [危険](javascript:alert(1))',
          ),
        ),
      );
    const response = await getAivisModelInfo('http://127.0.0.1:10101', fetcher);
    expect(response.models[0].licenseText).toContain('<script>');
    expect(response.models[0].links).not.toContain('javascript:alert(1)');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('rejects stored metadata for the wrong product, speaker or style', () => {
    const evaluation = evaluationWithModelInfo(),
      candidate = evaluation.candidates[0];
    expect(castingCandidateSchema.safeParse(candidate).success).toBe(true);
    expect(
      castingCandidateSchema.safeParse({
        ...candidate,
        modelInfo: { ...modelInfo(), styleName: '別スタイル' },
      }).success,
    ).toBe(false);
    expect(
      castingCandidateSchema.safeParse({
        ...candidate,
        modelInfo: { ...modelInfo(), speakerUuid: modelUuid },
      }).success,
    ).toBe(false);
    expect(
      castingCandidateSchema.safeParse({ ...evaluation.candidates[1], modelInfo: modelInfo() })
        .success,
    ).toBe(false);
  });
  it('round trips snapshots through sessions, archives, CSV and reuse without upgrading history', () => {
    const item = evaluationWithModelInfo();
    expect(
      castingSessionSchema.parse(makeCastingSession([item])).evaluations[0].candidates[0].modelInfo,
    ).toEqual(modelInfo());
    const records = parseCastingEvaluationFile(
      JSON.parse(JSON.stringify(makeCastingDataset([item]))),
    );
    const resumed = resumeCastingEvaluation({}, records[0]);
    expect(resumed.candidates[resumed.pair[0]].modelInfo).toEqual(modelInfo());
    resumed.candidates[resumed.pair[0]].modelInfo!.modelVersion = '2.0.0';
    expect(records[0].candidates[0].modelInfo!.modelVersion).toBe('1.2.3');
    expect(castingEvaluationsCsv(records)).toContain('"a_model_license_text"');
    expect(castingEvaluationsCsv(records)).toContain('クレジット：検証用制作者');
    expect(
      filterCastingEvaluations(records, { ...defaultCastingFilters, query: '検証用モデル' }),
    ).toHaveLength(1);
  });
  it('normalizes snapshot timestamp/UUID spelling but keeps absent or changed metadata separate', () => {
    const original = evaluationWithModelInfo(),
      duplicate = structuredClone(original);
    const info = duplicate.candidates[0].modelInfo!;
    info.checkedAt = '2026-10-21T12:00:00Z';
    info.speakerUuid = info.speakerUuid.toUpperCase();
    expect(castingEvaluationKey(original)).toBe(castingEvaluationKey(duplicate));
    const changed = structuredClone(original);
    changed.candidates[0].modelInfo!.modelVersion = '2.0.0';
    const absent = structuredClone(original);
    delete absent.candidates[0].modelInfo;
    expect(mergeCastingEvaluations([original], [duplicate, changed, absent]).records).toHaveLength(
      3,
    );
    expect(
      modelInfoChanged(original.candidates[0].modelInfo!, duplicate.candidates[0].modelInfo!),
    ).toBe(false);
    expect(
      modelInfoChanged(original.candidates[0].modelInfo!, changed.candidates[0].modelInfo!),
    ).toBe(true);
  });
});
