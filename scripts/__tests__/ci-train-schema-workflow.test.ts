/// <reference types="node" />

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const WORKFLOW_PATH = '.github/workflows/ci.yml';
const DRIFT_SPEC_PATH = 'packages/mobile/src/lib/graphql/__tests__/screenshot-fixture-drift.test.ts';
const workflowSource = readFileSync(WORKFLOW_PATH, 'utf8');

/**
 * Return one YAML mapping entry by exact key and indentation. Copied from
 * ci-lint-scope.test.ts / ci-location-sync-workflow.test.ts on purpose: the
 * repo declares no YAML parser, and a CI contract test is not worth the
 * dependency churn.
 */
function mappingEntry(source: string, key: string, indentation: number): string {
  const lines = source.split('\n');
  const prefix = `${' '.repeat(indentation)}${key}:`;
  const startIndex = lines.findIndex((line) => line.startsWith(prefix));
  if (startIndex < 0) {
    throw new Error(`missing ${key} mapping at indentation ${indentation}`);
  }

  let endIndex = lines.length;
  for (let lineIndex = startIndex + 1; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const lineIndentation = line.length - line.trimStart().length;
    if (lineIndentation <= indentation) {
      endIndex = lineIndex;
      break;
    }
  }

  return lines.slice(startIndex, endIndex).join('\n');
}

/**
 * One step of a job, found by its `id:`, from its `- ` line to the next step at
 * the same indentation.
 */
function stepWithId(jobSource: string, id: string): string {
  const lines = jobSource.split('\n');
  const idIndex = lines.findIndex((line) => line.trim() === `id: ${id}`);
  if (idIndex < 0) {
    throw new Error(`missing step with id ${id}`);
  }
  let startIndex = idIndex;
  while (startIndex > 0 && !lines[startIndex].startsWith('      - ')) startIndex -= 1;
  let endIndex = startIndex + 1;
  while (endIndex < lines.length && !lines[endIndex].startsWith('      - ')) endIndex += 1;
  return lines.slice(startIndex, endIndex).join('\n');
}

/** Strip `#` comment lines so a job's rationale can never satisfy an assertion. */
function withoutComments(source: string): string {
  return source
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n');
}

/**
 * Train tester builds and train OTAs query ws.boardsesh.com, which deploys from
 * `main`. #5973 put `climbRevisions` and the query selecting it on `release/next`
 * together, so testers got GRAPHQL_VALIDATION_FAILED for 2.5 days (#6111). The
 * `train-schema-on-main` step validates mobile's operations against
 * origin/main's committed schema; this contract stops the gate or the
 * comparison direction from being quietly undone.
 */
describe('train-schema-on-main CI guard contract', () => {
  const guardsJob = withoutComments(mappingEntry(workflowSource, 'guards', 2));
  const step = stepWithId(guardsJob, 'train-schema-on-main');
  const driftSpec = readFileSync(DRIFT_SPEC_PATH, 'utf8');

  it('runs for pull requests into release/next, and when ci.yml itself changes', () => {
    expect(step).toContain('!cancelled()');
    expect(step).toContain("github.event_name == 'pull_request' && github.base_ref == 'release/next'");
    expect(step).toContain("needs.changes.outputs.rootCi == 'true'");
    expect(step).not.toContain('continue-on-error');
  });

  it("validates against origin/main's schema, fetched first", () => {
    const fetchIndex = step.indexOf('git fetch --no-tags --depth=1 origin main:refs/remotes/origin/main');
    const showIndex = step.indexOf('git show origin/main:packages/shared-schema/src/generated/schema.graphql');
    const testIndex = step.indexOf('packages/mobile/src/lib/graphql/__tests__/screenshot-fixture-drift.test.ts');
    expect(fetchIndex).toBeGreaterThanOrEqual(0);
    expect(showIndex).toBeGreaterThan(fetchIndex);
    expect(testIndex).toBeGreaterThan(showIndex);
    expect(step).toContain('PRODUCTION_SCHEMA_SDL=');
    // The base is the train, so it must never be the schema's own checkout.
    expect(step).not.toContain('origin/$BASE_REF');
    expect(step).not.toContain('origin/release/next');
  });

  it('selects the production-schema check that the SDL variable turns on', () => {
    expect(step).toContain('production \\(main\\) schema');
    expect(driftSpec).toContain(
      "it.runIf(process.env.PRODUCTION_SCHEMA_SDL)('validates every document against the production (main) schema'",
    );
    // Direction: the registered documents are validated against the schema read
    // from the env path, not the checkout's own typeDefs.
    expect(driftSpec).toContain("buildSchema(readFileSync(process.env.PRODUCTION_SCHEMA_SDL as string, 'utf8'))");
    expect(driftSpec).toContain('validate(productionSchema, parse(registered.document))');
  });

  it('runs this contract spec from inside the step it guards', () => {
    expect(step).toContain('scripts/__tests__/ci-train-schema-workflow.test.ts');
  });
});
