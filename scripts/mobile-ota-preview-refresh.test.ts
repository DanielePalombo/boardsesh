/// <reference types="node" />

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';

interface WorkflowStep {
  id?: string;
  with?: { script?: string };
}
interface Workflow {
  permissions?: Record<string, string>;
  jobs: Record<string, { steps: WorkflowStep[] }>;
}
const readWorkflow = (name: string) =>
  parse(readFileSync(resolve(import.meta.dirname, `../.github/workflows/${name}.yml`), 'utf8')) as Workflow;
const refresh = readWorkflow('mobile-ota-preview-refresh');
const publisher = readWorkflow('mobile-ota-preview');
const pr = (number = 7, base = 'main', repository = 'boardsesh/boardsesh', ref = 'feature') => ({
  number,
  state: 'open',
  head: { sha: 'a'.repeat(40), ref, repo: { full_name: repository } },
  base: { ref: base },
});
const history = (nodes: unknown[] = [], hasPreviousPage = false, startCursor: string | null = null) => ({
  repository: { pullRequest: { timelineItems: { nodes, pageInfo: { hasPreviousPage, startCursor } } } },
});
const previewEvent = (task = 'deploy', state = 'FAILURE') => ({
  deployment: {
    environment: 'pr-preview',
    description: 'OTA preview pr-7',
    task,
    state,
    commitOid: 'b'.repeat(40),
  },
});

async function execute(script: string | undefined, github: unknown, eventName: string, inputs = {}) {
  if (!script) throw new Error('Workflow script missing');
  const outputs = new Map<string, unknown>();
  const core = {
    info: vi.fn(),
    notice: vi.fn(),
    setOutput: (key: string, result: unknown) => outputs.set(key, result),
  };
  // Execute actual workflow code with injected API/context objects and no shell environment.
  // oxlint-disable-next-line no-implied-eval
  const run = new Function('github', 'context', 'core', `return (async () => {\n${script}\n})();`) as (
    github: unknown,
    context: unknown,
    core: unknown,
  ) => Promise<void>;
  await run(
    github,
    {
      repo: { owner: 'boardsesh', repo: 'boardsesh' },
      eventName,
      payload: { repository: { default_branch: 'main' }, inputs },
    },
    core,
  );
  return outputs;
}

function fixture(options: { pulls?: ReturnType<typeof pr>[]; mobile?: boolean; pages?: unknown[] } = {}) {
  const pulls = { list: vi.fn(), listFiles: vi.fn(), get: vi.fn(async () => ({ data: pr() })) };
  const actions = { createWorkflowDispatch: vi.fn(async () => ({})) };
  const pages = [...(options.pages ?? [history()])];
  const graphql = vi.fn(async (_query: string, _variables: unknown) => pages.shift());
  const paginate = vi.fn(async (method: unknown, _options: unknown) =>
    method === pulls.list
      ? (options.pulls ?? [pr()])
      : [{ filename: options.mobile ? 'packages/mobile/app/index.tsx' : 'packages/web/app/page.tsx' }],
  );
  const github = { rest: { pulls, actions }, paginate, graphql };
  const run = () => execute(refresh.jobs.refresh.steps[0].with?.script, github, 'push');
  return { github, actions, graphql, run };
}

describe('base-refresh preview cleanup discovery', () => {
  it('refreshes a mobile PR without reading deployment history', async () => {
    const { run, graphql, actions } = fixture({ mobile: true });
    await run();
    expect(graphql).not.toHaveBeenCalled();
    expect(actions.createWorkflowDispatch).toHaveBeenCalledWith(
      expect.objectContaining({ inputs: { pr: '7' }, ref: 'main' }),
    );
  });

  it.each(['deploy', 'ota-preview-pr-7'])(
    'reconciles absorbed mobile changes using old-head %s deployments, including failed partial uploads',
    async (task) => {
      const { run, actions, github } = fixture({ pages: [history([previewEvent(task)])] });
      await run();
      expect(actions.createWorkflowDispatch).toHaveBeenCalledWith(expect.objectContaining({ inputs: { pr: '7' } }));
      const decide = publisher.jobs.gate.steps.find((step) => step.id === 'decide');
      const outputs = await execute(decide?.with?.script, github, 'workflow_dispatch', { pr: '7' });
      expect(outputs.get('action')).toBe('cleanup');
      expect(outputs.get('cleanup_reason')).toBe('no-mobile');
      expect(outputs.get('head_sha')).toBe(pr().head.sha);
    },
  );

  it('walks backward past unrelated deployments to find a preview before a force-push', async () => {
    const { run, graphql, actions } = fixture({
      pages: [
        history([{ deployment: { environment: 'web-preview', description: 'web' } }], true, 'older'),
        history([previewEvent('deploy', 'SUCCESS')]),
      ],
    });
    await run();
    expect(graphql).toHaveBeenCalledTimes(2);
    expect(graphql).toHaveBeenNthCalledWith(2, expect.stringContaining('DEPLOYED_EVENT'), {
      owner: 'boardsesh',
      repo: 'boardsesh',
      number: 7,
      before: 'older',
    });
    expect(actions.createWorkflowDispatch).toHaveBeenCalledTimes(1);
  });

  it('skips unrelated web PRs, wrong environments and another PR’s preview', async () => {
    const { run, actions } = fixture({
      pages: [
        history([
          { deployment: { environment: 'production', description: 'OTA preview pr-7' } },
          { deployment: { environment: 'pr-preview', description: 'OTA preview pr-8' } },
          { deployment: null },
        ]),
      ],
    });
    await run();
    expect(actions.createWorkflowDispatch).not.toHaveBeenCalled();
  });

  it('keeps forks, train merge-backs and unsupported bases outside the dispatcher', async () => {
    const { run, graphql, actions, github } = fixture({
      pulls: [pr(7, 'main', 'outsider/fork'), pr(8, 'main', 'boardsesh/boardsesh', 'release/next'), pr(9, 'other')],
    });
    await run();
    expect(github.paginate).toHaveBeenCalledTimes(1);
    expect(graphql).not.toHaveBeenCalled();
    expect(actions.createWorkflowDispatch).not.toHaveBeenCalled();
  });

  it.each([null, {}, history([], true, null), history([], true, '')])(
    'fails visibly when deployment history cannot prove there was no preview: %j',
    async (page) => {
      const { run, actions } = fixture({ pages: [page] });
      await expect(run()).rejects.toThrow();
      expect(actions.createWorkflowDispatch).not.toHaveBeenCalled();
    },
  );

  it('rejects a repeated pagination cursor', async () => {
    const { run } = fixture({ pages: [history([], true, 'same'), history([], true, 'same')] });
    await expect(run()).rejects.toThrow('Invalid preview deployment history cursor');
  });

  it('surfaces history API failures rather than silently skipping cleanup', async () => {
    const { run, graphql } = fixture();
    graphql.mockRejectedValueOnce(new Error('History unavailable'));
    await expect(run()).rejects.toThrow('History unavailable');
    expect(refresh.permissions?.deployments).toBe('read');
  });
});
