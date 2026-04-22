import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';

type DimensionSpecDocument = {
  schemaVersion: number;
  dimensions: Array<{
    id: string;
    label: string;
    weight: number;
    subFields: string[];
    required: boolean;
  }>;
};

type DimensionSchema = {
  properties: {
    schemaVersion: { const: number };
    dimensions: {
      minItems: number;
      items: {
        required: string[];
        additionalProperties: boolean;
        properties: {
          id: { pattern: string };
          label: { minLength: number };
          weight: { minimum: number; maximum: number };
          subFields: { items: { type: string } };
          required: { type: string };
        };
      };
    };
  };
};

async function loadJson<T>(relativePath: string): Promise<T> {
  const filePath = path.resolve(relativePath);
  return JSON.parse(await readFile(filePath, 'utf8')) as T;
}

function validateAgainstSchema(document: DimensionSpecDocument, schema: DimensionSchema): string[] {
  const errors: string[] = [];
  if (document.schemaVersion !== schema.properties.schemaVersion.const) {
    errors.push('schemaVersion mismatch');
  }

  if (document.dimensions.length < schema.properties.dimensions.minItems) {
    errors.push('dimensions shorter than schema minimum');
  }

  const idPattern = new RegExp(schema.properties.dimensions.items.properties.id.pattern);
  const expectedKeys = [...schema.properties.dimensions.items.required].sort();

  for (const dimension of document.dimensions) {
    const keys = Object.keys(dimension).sort();
    if (schema.properties.dimensions.items.additionalProperties === false) {
      assert.deepEqual(keys, expectedKeys);
    }

    if (!idPattern.test(dimension.id)) {
      errors.push(`invalid id: ${dimension.id}`);
    }
    if (dimension.label.length < schema.properties.dimensions.items.properties.label.minLength) {
      errors.push(`invalid label: ${dimension.id}`);
    }
    if (
      dimension.weight < schema.properties.dimensions.items.properties.weight.minimum ||
      dimension.weight > schema.properties.dimensions.items.properties.weight.maximum
    ) {
      errors.push(`invalid weight: ${dimension.id}`);
    }
    if (!Array.isArray(dimension.subFields)) {
      errors.push(`invalid subFields: ${dimension.id}`);
    }
    if (typeof dimension.required !== 'boolean') {
      errors.push(`invalid required: ${dimension.id}`);
    }
  }

  return errors;
}

describe('interview dimensions', () => {
  it('dimensions.json satisfies the schema contract and required inventory', async () => {
    const document = await loadJson<DimensionSpecDocument>(
      '.claude/skills/vibe-interview/dimensions.json',
    );
    const schema = await loadJson<DimensionSchema>(
      '.claude/skills/vibe-interview/dimensions.schema.json',
    );

    const errors = validateAgainstSchema(document, schema);
    assert.deepEqual(errors, []);
    assert.equal(document.dimensions.length, 10);

    const ids = document.dimensions.map((dimension) => dimension.id);
    assert.equal(new Set(ids).size, ids.length);

    for (const requiredId of [
      'goal',
      'target_user',
      'platform',
      'data_model',
      'primary_interaction',
      'success_metric',
      'constraints',
      'domain_specifics',
    ]) {
      assert.equal(ids.includes(requiredId), true);
    }

    for (const dimension of document.dimensions) {
      assert.equal(dimension.weight >= 0 && dimension.weight <= 1, true);
    }
  });
});
