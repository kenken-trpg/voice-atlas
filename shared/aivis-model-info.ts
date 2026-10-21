import { z } from 'zod';

export const maxModelInfoBytes = 4096;
export function safeModelLink(input: string): string | null {
  if (input.length > 2048 || /[\u0000-\u0020\u007f]/.test(input)) return null;
  try {
    const url = new URL(input);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}
const linkSchema = z
  .string()
  .max(2048)
  .refine((value) => safeModelLink(value) !== null, 'HTTP/HTTPSのリンクを指定してください。');
export const aivisModelInfoSchema = z
  .object({
    engine: z.literal('AivisSpeech'),
    source: z.literal('/aivm_models'),
    checkedAt: z.iso.datetime(),
    modelUuid: z.uuid(),
    modelName: z.string().min(1).max(200),
    modelVersion: z
      .string()
      .min(1)
      .max(100)
      .regex(/^[^\u0000-\u001f\u007f]+$/),
    description: z.string().max(500),
    creators: z.array(z.string().min(1).max(255)).max(20),
    speakerUuid: z.uuid(),
    styleName: z.string().min(1).max(200),
    licenseStatus: z.enum(['provided', 'not-provided', 'omitted']),
    licenseText: z.string().min(1).max(12000).nullable(),
    links: z.array(linkSchema).max(5),
  })
  .refine(
    (info) => (info.licenseStatus === 'provided') === (info.licenseText !== null),
    '利用条件の状態と本文が一致しません。',
  )
  .refine(
    (info) => new TextEncoder().encode(JSON.stringify(info)).byteLength <= maxModelInfoBytes,
    'モデル情報の保存上限を超えました。',
  );
export type AivisModelInfo = z.infer<typeof aivisModelInfoSchema>;
export const aivisModelInfoResponseSchema = z.object({
  ready: z.boolean(),
  checkedAt: z.iso.datetime(),
  models: z.array(aivisModelInfoSchema).max(200),
});
export type AivisModelInfoResponse = z.infer<typeof aivisModelInfoResponseSchema>;
export function modelInfoKey(info: Pick<AivisModelInfo, 'speakerUuid' | 'styleName'>) {
  return JSON.stringify([info.speakerUuid.toLowerCase(), info.styleName]);
}
export function modelInfoChanged(a: AivisModelInfo, b: AivisModelInfo) {
  const normalize = (input: AivisModelInfo) => {
    const { checkedAt: _checkedAt, ...info } = aivisModelInfoSchema.parse(input);
    return {
      ...info,
      modelUuid: info.modelUuid.toLowerCase(),
      speakerUuid: info.speakerUuid.toLowerCase(),
    };
  };
  return JSON.stringify(normalize(a)) !== JSON.stringify(normalize(b));
}
