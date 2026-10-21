import { aivisModelInfoSchema } from '../../shared/aivis-model-info';
import { makeCastingEvaluation } from './casting';
export const modelUuid = '22222222-2222-4222-8222-222222222222';
export const speakerUuid = 'abcdefab-1111-4111-8111-111111111111';
export function aivisModelsPayload(
  license = '# 利用条件\nクレジット：検証用制作者\nhttps://example.com/terms',
) {
  return {
    [modelUuid]: {
      is_loaded: false,
      file_path: '/private/test/do-not-expose.aivmx',
      manifest: {
        manifest_version: '1.0',
        uuid: modelUuid,
        name: '検証用モデル',
        version: '1.2.3',
        description: 'モデル情報の検証',
        creators: ['検証用制作者 (https://example.com/creator)'],
        license,
        speakers: [
          {
            uuid: speakerUuid,
            name: '評価用話者',
            icon: 'data:image/png;base64,private',
            styles: [
              {
                name: 'ノーマル',
                local_id: 0,
                voice_samples: [{ audio: 'data:audio/wav;base64,private' }],
              },
              { name: 'ささやき', local_id: 1 },
            ],
          },
        ],
      },
    },
  };
}
export function modelInfo() {
  return aivisModelInfoSchema.parse({
    engine: 'AivisSpeech',
    source: '/aivm_models',
    checkedAt: '2026-10-21T12:00:00.000Z',
    modelUuid,
    modelName: '検証用モデル',
    modelVersion: '1.2.3',
    description: 'モデル情報の検証',
    creators: ['検証用制作者'],
    speakerUuid,
    styleName: 'ノーマル',
    licenseStatus: 'provided',
    licenseText: 'クレジット：検証用制作者',
    links: ['https://example.com/terms'],
  });
}
export function evaluationWithModelInfo() {
  const item = makeCastingEvaluation();
  item.candidates[0].modelInfo = modelInfo();
  return item;
}
