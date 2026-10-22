import { z } from 'zod';
import { listeningSentences, listeningSentenceRevision } from './listening-evaluation';

const unique = <T>(values: T[]) => new Set(values).size === values.length;
const path = z.string().trim().min(1).max(4096);
const common = {
  format: z.literal('voice-atlas-irodori-config'),
  version: z.literal(1),
  checkpoint: path,
  codecPath: path,
  device: z.enum(['cpu', 'mps', 'cuda']),
  seeds: z
    .array(
      z
        .number()
        .int()
        .min(0)
        .max(2 ** 32 - 1),
    )
    .min(2)
    .max(4)
    .refine(unique),
  steps: z.array(z.number().int().min(1).max(100)).min(1).max(3).refine(unique),
  sentenceIds: z
    .array(z.enum(listeningSentences.map((sentence) => sentence.id)))
    .min(2)
    .max(6)
    .refine(unique),
  machineNote: z.string().max(500).default(''),
};

// Deliberately separate the two checkpoint families. VoiceDesign ignores reference
// inputs; the base model does not use captions to design a speaker.
export const irodoriEvaluationSchema = z.discriminatedUnion('mode', [
  z.strictObject({
    ...common,
    mode: z.literal('voice-design'),
    captions: z.array(z.string().trim().min(1).max(1000)).min(1).max(3).refine(unique),
  }),
  z.strictObject({
    ...common,
    mode: z.literal('reference'),
    referenceWav: path,
    referenceNote: z.string().max(1000).default(''),
  }),
]);
export type IrodoriEvaluationConfig = z.infer<typeof irodoriEvaluationSchema>;

export function makeIrodoriPlan(raw: unknown) {
  const config = irodoriEvaluationSchema.parse(raw);
  const conditions = config.mode === 'voice-design' ? config.captions : [null];
  const samples: {
    id: string;
    condition: number;
    sentenceId: string;
    text: string;
    caption: string | null;
    seed: number;
    steps: number;
    repeatOf: string | null;
  }[] = [];
  for (const [condition, caption] of conditions.entries()) {
    for (const steps of config.steps) {
      const first = samples.length;
      for (const seed of config.seeds) {
        for (const sentenceId of config.sentenceIds) {
          const sentence = listeningSentences.find((item) => item.id === sentenceId)!;
          samples.push({
            id: `sample-${String(samples.length + 1).padStart(3, '0')}`,
            condition: condition + 1,
            sentenceId,
            text: sentence.text,
            caption,
            seed,
            steps,
            repeatOf: null,
          });
        }
      }
      // Repeat the first sentence/seed after other texts and seeds have run. A
      // matching WAV hash is repeatability evidence, not speaker consistency.
      samples.push({
        ...samples[first],
        id: `sample-${String(samples.length + 1).padStart(3, '0')}`,
        repeatOf: samples[first].id,
      });
    }
  }
  return {
    format: 'voice-atlas-irodori-plan' as const,
    version: 1 as const,
    sentenceRevision: listeningSentenceRevision,
    config,
    runtime: {
      model_precision: 'fp32',
      codec_precision: 'fp32',
      codec_deterministic_encode: true,
      codec_deterministic_decode: true,
      enable_watermark: false,
      compile_model: false,
      compile_dynamic: false,
    },
    sampling: {
      seconds: 30,
      num_candidates: 1,
      decode_mode: 'sequential',
      max_ref_seconds: 30,
      ref_normalize_db: -16,
      ref_ensure_max: true,
      cfg_scale_text: 3,
      cfg_scale_caption: config.mode === 'voice-design' ? 3 : 0,
      cfg_scale_speaker: config.mode === 'reference' ? 5 : 0,
      cfg_guidance_mode: 'independent',
      cfg_min_t: 0.5,
      cfg_max_t: 1,
      context_kv_cache: true,
      trim_tail: true,
      tail_window_size: 20,
      tail_std_threshold: 0.05,
      tail_mean_threshold: 0.1,
    },
    samples,
  };
}
