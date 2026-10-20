import { z } from 'zod';
import { analysisSchema } from '../shared/schema';

// Build provider variants once. The original Zod schema still validates every response.
function providerSchema(constraintsAsHints: string[]) {
  const schema = z.toJSONSchema(analysisSchema, {
    override: ({ jsonSchema }) => {
      const node = jsonSchema as Record<string, unknown>;
      const hints: string[] = [];
      for (const key of constraintsAsHints) {
        if (key in node) {
          hints.push(`${key}: ${node[key]}`);
          delete node[key];
        }
      }
      if (hints.length) node.description = [node.description, ...hints].filter(Boolean).join('; ');
    },
  });
  delete schema.$schema;
  return schema;
}

const standard = z.toJSONSchema(analysisSchema);
export const analysisSchemas = {
  ollama: standard,
  openai: standard,
  anthropic: providerSchema([
    'minimum',
    'maximum',
    'minLength',
    'maxLength',
    'minItems',
    'maxItems',
  ]),
  gemini: providerSchema(['minLength', 'maxLength']),
};
