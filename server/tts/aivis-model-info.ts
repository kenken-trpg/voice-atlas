import { z } from 'zod';
import { loopbackUrl } from '../config';
import { remoteBytes, type Fetcher } from '../remote';
import {
  aivisModelInfoSchema,
  modelInfoKey,
  safeModelLink,
  type AivisModelInfo,
  type AivisModelInfoResponse,
} from '../../shared/aivis-model-info';

const manifestSchema = z.object({
  manifest_version: z.literal('1.0'),
  uuid: z.uuid(),
  name: z.string().min(1).max(200),
  version: z.string().min(1).max(100),
  description: z.string().max(500).default(''),
  creators: z.array(z.string().min(1).max(255)).max(20).default([]),
  license: z.string().nullable().default(null),
  speakers: z
    .array(
      z.object({
        uuid: z.uuid(),
        styles: z.array(z.object({ name: z.string().min(1).max(200) })).max(32),
      }),
    )
    .max(200),
});
function relatedLinks(manifest: z.infer<typeof manifestSchema>) {
  const matches =
    [manifest.license ?? '', ...manifest.creators].join('\n').match(/https?:\/\/[^\s<>"\]]+/gi) ??
    [];
  return [
    ...new Set(
      matches
        .map((value) => safeModelLink(value.replace(/[),.;]+$/g, '')))
        .filter((value): value is string => value !== null),
    ),
  ].slice(0, 5);
}
export async function getAivisModelInfo(
  rawUrl: string,
  fetcher: Fetcher = fetch,
): Promise<AivisModelInfoResponse> {
  const baseUrl = loopbackUrl(rawUrl);
  try {
    // This API may include images/audio. Bound the response, and return only whitelisted text.
    const bytes = await remoteBytes(`${baseUrl}/aivm_models`, {}, 2500, fetcher, 8 * 1024 * 1024);
    const raw = z.record(z.string(), z.unknown()).parse(JSON.parse(bytes.toString('utf8')));
    const checkedAt = new Date().toISOString();
    const entries = new Map<string, AivisModelInfo | null>();
    for (const [key, value] of Object.entries(raw)) {
      const parsed = z.object({ manifest: manifestSchema }).safeParse(value);
      if (!parsed.success || key.toLowerCase() !== parsed.data.manifest.uuid.toLowerCase())
        continue;
      const manifest = parsed.data.manifest;
      const links = relatedLinks(manifest);
      for (const speaker of manifest.speakers)
        for (const style of speaker.styles) {
          const entryKey = modelInfoKey({ speakerUuid: speaker.uuid, styleName: style.name });
          if (entries.has(entryKey)) {
            entries.set(entryKey, null);
            continue;
          }
          if (entries.size >= 200) continue;
          const licenseText = manifest.license?.trim() ? manifest.license : null;
          const base = {
            engine: 'AivisSpeech' as const,
            source: '/aivm_models' as const,
            checkedAt,
            modelUuid: manifest.uuid,
            modelName: manifest.name,
            modelVersion: manifest.version,
            description: manifest.description,
            creators: manifest.creators,
            speakerUuid: speaker.uuid,
            styleName: style.name,
            links,
          };
          let info = aivisModelInfoSchema.safeParse({
            ...base,
            licenseStatus: licenseText ? 'provided' : 'not-provided',
            licenseText,
          });
          // Never present a cut-off license as the full policy. Keep the other fields if possible.
          if (!info.success && licenseText)
            info = aivisModelInfoSchema.safeParse({
              ...base,
              licenseStatus: 'omitted',
              licenseText: null,
            });
          if (info.success) entries.set(entryKey, info.data);
        }
    }
    return {
      ready: true,
      checkedAt,
      models: [...entries.values()].filter((item): item is AivisModelInfo => item !== null),
    };
  } catch {
    return { ready: false, checkedAt: new Date().toISOString(), models: [] };
  }
}
