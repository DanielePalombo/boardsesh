/// <reference types="node" />

import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

// The automatic merge-back submission and the workflows it shares locks with.
// Text and structure are pinned here; the decisions that live in shell are run
// under bash further down.

type Step = { id?: string; name?: string; if?: string; run?: string; uses?: string; env?: Record<string, string> };
type Job = {
  if?: string;
  needs?: string | string[];
  environment?: string;
  uses?: string;
  with?: Record<string, string>;
  secrets?: string;
  permissions?: Record<string, string>;
  concurrency?: Record<string, unknown>;
  outputs?: Record<string, string>;
  env?: Record<string, string>;
  steps?: Step[];
};
type Workflow = {
  name: string;
  on: Record<string, unknown>;
  concurrency?: Record<string, unknown>;
  permissions?: Record<string, string>;
  env?: Record<string, string>;
  jobs: Record<string, Job>;
};

const read = (name: string) => readFileSync(`.github/workflows/${name}`, 'utf8');
const load = (name: string) => parse(read(name), { strict: true, uniqueKeys: true }) as Workflow;
const flatten = (value: string | undefined) => (value ?? '').replace(/\s+/g, ' ').trim();

const submit = load('mobile-store-submit.yml');
const submitSource = read('mobile-store-submit.yml');
const draft = load('mobile-store-draft.yml');
const draftSource = read('mobile-store-draft.yml');
const step = (job: string, name: string) => {
  const found = submit.jobs[job]?.steps?.find((entry) => entry.name === name);
  if (!found) throw new Error(`no step "${name}" in ${job}`);
  return found;
};

describe('mobile-store-submit.yml triggers', () => {
  it('runs on every main push, hourly, and on dispatch, and never on a PR', () => {
    expect(Object.keys(submit.on).sort()).toEqual(['push', 'schedule', 'workflow_dispatch']);
    expect(submit.on['push']).toEqual({ branches: ['main'] });
    const [schedule] = submit.on['schedule'] as Array<{ cron: string }>;
    // Hourly. The next train version's Android build cannot race a deferred
    // release: android-apk-rn.yml holds it until production carries the merge-back.
    expect(schedule?.cron).toBe('13 * * * *');
  });

  it('plans by default when dispatched, with an optional version', () => {
    const inputs = (submit.on['workflow_dispatch'] as { inputs: Record<string, Record<string, unknown>> }).inputs;
    expect(inputs['action']).toMatchObject({ type: 'choice', default: 'plan', options: ['plan', 'submit'] });
    expect(inputs['version']).toMatchObject({ type: 'string', required: false, default: '' });
  });

  it('works only from main', () => {
    expect(flatten(submit.jobs['target']?.if)).toContain("github.ref == 'refs/heads/main'");
    for (const job of ['status', 'draft', 'submit-ios', 'submit-android']) {
      expect(submit.jobs[job]?.needs, job).toContain('target');
    }
  });

  it('asks for read-only repository access, and actions: write only for the called draft', () => {
    expect(submit.permissions).toEqual({ contents: 'read', 'pull-requests': 'read' });
    expect(submit.jobs['draft']?.permissions).toEqual({ contents: 'read', actions: 'write' });
    for (const [name, job] of Object.entries(submit.jobs)) {
      if (name !== 'draft') expect(job.permissions, name).toBeUndefined();
    }
  });
});

describe('the mobile-store-draft lock', () => {
  it('holds the store-draft group for the whole run, queued', () => {
    expect(submit.concurrency).toEqual({ group: 'mobile-store-draft', 'cancel-in-progress': false, queue: 'max' });
  });

  // GitHub keeps one pending run per group and replaces the rest unless every
  // member queues. A merge-back submission must never be dropped behind a draft.
  it.each([
    'mobile-store-draft.yml',
    'mobile-store-review-submission.yml',
    'mobile-store-release-control.yml',
    'mobile-store-audit.yml',
  ])('%s queues in the same group', (name) => {
    const concurrency = load(name).concurrency as Record<string, string>;
    expect(concurrency['cancel-in-progress']).toBe(false);
    expect(concurrency['queue']).toBe('max');
    expect(concurrency['group']).toContain('mobile-store-draft');
  });

  it('finds every member of the group, so none is left without queue: max', () => {
    const members = readdirSync('.github/workflows').filter(
      (name) => read(name).includes("'mobile-store-draft'") || /group: mobile-store-draft$/m.test(read(name)),
    );
    expect(members.sort()).toEqual([
      'mobile-store-audit.yml',
      'mobile-store-draft.yml',
      'mobile-store-release-control.yml',
      'mobile-store-review-submission.yml',
      'mobile-store-submit.yml',
    ]);
  });

  // A called workflow's own concurrency applies too: in its caller's group it
  // would wait for the caller to finish, which waits for it.
  it('gives a called draft a per-run group of its own', () => {
    expect(draft.concurrency?.['group']).toBe(
      "${{ inputs.release_sha && format('mobile-store-draft-call-{0}', github.run_id) || 'mobile-store-draft' }}",
    );
    expect(submit.jobs['draft']?.uses).toBe('./.github/workflows/mobile-store-draft.yml');
    expect(submit.jobs['draft']?.with?.['release_sha']).toBe('${{ needs.target.outputs.release_sha }}');
  });
});

describe('mobile-store-draft.yml as a called workflow', () => {
  const call = draft.on['workflow_call'] as {
    inputs: Record<string, { required?: boolean; type: string; default?: string }>;
    outputs: Record<string, { value: string }>;
  };

  it('keeps its own triggers unchanged and adds workflow_call', () => {
    expect(Object.keys(draft.on).sort()).toEqual(['workflow_call', 'workflow_dispatch', 'workflow_run']);
    expect(call.inputs['release_sha']).toMatchObject({ required: true, type: 'string' });
    expect(call.inputs['platform']).toMatchObject({ type: 'string', default: 'all' });
  });

  it('reports what it found, including drafts that finished green without writing', () => {
    expect(Object.fromEntries(Object.entries(call.outputs).map(([key, output]) => [key, output.value]))).toEqual({
      candidate_ready: '${{ jobs.release-candidate.outputs.candidate_ready }}',
      version: '${{ jobs.release-candidate.outputs.version }}',
      ios_build_number: '${{ jobs.release-candidate.outputs.ios_build_number }}',
      ios_build_tag: '${{ jobs.release-candidate.outputs.ios_build_tag }}',
      android_version_code: '${{ jobs.release-candidate.outputs.android_version_code }}',
      android_build_tag: '${{ jobs.release-candidate.outputs.android_build_tag }}',
      ios_draft: "${{ jobs.ios.outputs.draft || 'skipped' }}",
      android_draft: "${{ jobs.android.outputs.draft || 'skipped' }}",
    });
    expect(draft.jobs['ios']?.outputs?.['draft']).toBe(
      "${{ steps.draft.outcome == 'skipped' && 'failure' || steps.draft.outcome }}",
    );
    expect(draft.jobs['android']?.outputs?.['draft']).toBe(
      "${{ steps.guard.outcome != 'success' && 'failure' || steps.draft.outcome }}",
    );
  });

  it('reads the platform from inputs, which a called run fills, not from its caller’s dispatch', () => {
    expect(draftSource).not.toContain('github.event.inputs.platform');
    expect(flatten(draft.jobs['ios']?.if)).toContain("inputs.platform == 'ios' || inputs.platform == 'all'");
    expect(flatten(draft.jobs['android']?.if)).toContain("inputs.platform == 'android' || inputs.platform == 'all'");
  });

  // Main moves many times a day, so "the branch has not moved" would abort most
  // called runs. A pinned commit must stay in main's history instead.
  it('pins the merge commit and checks it is in main instead of checking the branch head', () => {
    expect(draft.env?.['PINNED_RELEASE_SHA']).toBe('${{ inputs.release_sha }}');
    const compare =
      /gh api "repos\/\$\{GITHUB_REPOSITORY\}\/compare\/\$\{(?:PINNED|EXPECTED)_RELEASE_SHA\}\.\.\.main" --jq '\.status'/g;
    // Resolve, the post-fingerprint recheck, and both store jobs' prechecks.
    expect(draftSource.match(compare)).toHaveLength(4);
    expect(draftSource.match(/ahead\|identical\) ;;/g)?.length).toBeGreaterThanOrEqual(4);
    // The tag rechecks stay on every path.
    expect(draftSource.match(/assert_ref "tags\/\$EXPECTED_IOS_TAG" "\$EXPECTED_IOS_SHA"/g)).toHaveLength(2);
    expect(draftSource.match(/assert_ref "tags\/\$EXPECTED_ANDROID_TAG" "\$EXPECTED_ANDROID_SHA"/g)).toHaveLength(2);
  });

  it('leaves listing and screenshot follow-ups to the submit workflow on a called run', () => {
    const iosSteps = draft.jobs['ios']?.steps ?? [];
    for (const name of [
      "Push listing text and What's New onto the drafted version",
      'Install screenshot tooling',
      'Fetch screenshot baseline',
      'Attach baseline screenshots to the draft',
      'Warn if no screenshot baseline has been published yet',
    ]) {
      expect(flatten(iosSteps.find((entry) => entry.name === name)?.if), name).toContain('!inputs.release_sha');
    }
  });

  // A version already in a review draft is resumed without the draft lane, which
  // cannot see that state and would try to create the version again.
  it('writes no Android draft and, in a plan or a resumed review draft, no draft at all', () => {
    expect(submit.jobs['draft']?.with?.['platform']).toBe(
      "${{ needs.target.outputs.mode == 'submit' && vars.STORE_AUTO_SUBMIT != 'off' && needs.status.outputs.ios_status == 'pending' && needs.status.outputs.ios_needs_draft == 'true' && 'ios' || 'none' }}",
    );
    expect(submit.jobs['draft']?.secrets).toBe('inherit');
  });
});

describe('store writes', () => {
  const writeCommands = [
    'fastlane ios metadata',
    'lib/store_release_control.rb',
    'action:submit',
    'mobile-store-submit-android.ts --apply',
  ];
  const writeSteps = Object.entries(submit.jobs).flatMap(([job, definition]) =>
    (definition.steps ?? [])
      .filter((entry) => writeCommands.some((command) => entry.run?.includes(command)))
      .map((entry) => ({ job, entry })),
  );

  it('finds one gated step per store write', () => {
    expect(writeSteps.map(({ job, entry }) => `${job}: ${entry.name}`)).toEqual([
      "submit-ios: Push listing text and What's New",
      'submit-ios: Release on approval',
      'submit-ios: Submit for App Review',
      'submit-android: Release to production at 100%',
    ]);
  });

  // STORE_AUTO_SUBMIT=off, or a dispatched plan, must reach every write.
  it('gates every write on the kill switch and the run mode, read again in each job', () => {
    for (const { job, entry } of writeSteps) {
      expect(flatten(entry.if), `${job}: ${entry.name}`).toMatch(/^env\.SUBMIT == 'true'( && .+)?$/);
    }
    for (const job of ['submit-ios', 'submit-android']) {
      expect(submit.jobs[job]?.env?.['SUBMIT'], job).toBe(
        "${{ needs.target.outputs.mode == 'submit' && vars.STORE_AUTO_SUBMIT != 'off' }}",
      );
    }
    // A plan reads both stores but writes nothing.
    expect(flatten(step('submit-android', 'Plan the Android release').if)).toBe("env.SUBMIT != 'true'");
    expect(step('submit-android', 'Plan the Android release').run).not.toContain('--apply');
    // With the kill switch off, hourly runs stop; a push or a dispatch still plans.
    expect(flatten(submit.jobs['target']?.if)).toContain(
      "github.event_name != 'schedule' || vars.STORE_AUTO_SUBMIT != 'off'",
    );
    expect(step('target', 'Resolve the merge-back to submit').env).toMatchObject({
      STORE_AUTO_SUBMIT: '${{ vars.STORE_AUTO_SUBMIT }}',
      SUBMIT_ACTION: '${{ inputs.action }}',
    });
  });

  it('asks the stores before drafting, and submits only what they call pending', () => {
    expect(submit.jobs['status']?.environment).toBe('Production');
    expect(submit.jobs['target']?.environment).toBeUndefined();
    expect(flatten(submit.jobs['status']?.if)).toBe("needs.target.outputs.proceed == 'true'");
    expect(flatten(submit.jobs['draft']?.if)).toBe(
      "needs.status.outputs.ios_status == 'pending' || needs.status.outputs.android_status == 'pending'",
    );
    expect(flatten(submit.jobs['submit-ios']?.if)).toBe("needs.status.outputs.ios_status == 'pending'");
    expect(flatten(submit.jobs['submit-android']?.if)).toBe("needs.status.outputs.android_status == 'pending'");
    for (const job of ['submit-ios', 'submit-android']) {
      expect(submit.jobs[job]?.environment, job).toBe('Production');
      expect(submit.jobs[job]?.steps?.[0]?.name, job).toBe('Require the exact verified candidate');
    }
    expect(step('status', 'Where the iOS version stands').run).toContain('bundle exec fastlane ios submission_status');
    expect(step('status', 'Where the Android build stands').run).toContain('mobile-store-submit-android.ts --status');
  });

  // The text goes first: it also creates any locale the version lacks.
  it('pushes the text, checks readiness, sets release on approval, plans, then submits', () => {
    const names = (submit.jobs['submit-ios']?.steps ?? []).map((entry) => entry.name);
    const order = [
      'Take the listing text from the merge commit',
      "Push listing text and What's New",
      'Check the App Store version is ready',
      'Release on approval',
      'Plan the review submission',
      'Submit for App Review',
    ].map((name) => names.indexOf(name));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((left, right) => left - right)).toEqual(order);
    expect(step('submit-ios', 'Check the App Store version is ready').run).toContain(
      'fastlane ios audit surfaces:default',
    );
    expect(step('submit-ios', "Push listing text and What's New").run).toContain('"expected_version:$RELEASE_VERSION"');
    expect(step('submit-ios', 'Submit for App Review').env?.['REVIEW_SNAPSHOT_SHA256']).toBe(
      '${{ steps.plan.outputs.snapshot_sha256 }}',
    );
    // Only the default app page; custom product pages stay manual.
    expect(submitSource.match(/surfaces:default/g)).toHaveLength(3);
    expect(submitSource).not.toMatch(/surfaces:(?!default)/);
  });

  it('serializes the Android release with every Play production writer', () => {
    expect(submit.jobs['submit-android']?.concurrency).toEqual({
      group: 'play-production-track',
      'cancel-in-progress': false,
      queue: 'max',
    });
  });

  it('retains the readiness audit, plan and receipts', () => {
    for (const job of ['submit-ios', 'submit-android']) {
      const upload = submit.jobs[job]?.steps?.find((entry) => entry.uses === 'actions/upload-artifact@v4');
      expect(upload?.if, job).toBe('always()');
    }
  });
});

describe('cheap runs under the lock', () => {
  // Most runs end at the target job while holding mobile-store-draft, so it does
  // not install the workspace: the scripts it and the store reads run import only
  // Node builtins, through a tsx pinned to the lockfile's.
  const lockfileTsx = /\n {6}tsx:\n {8}specifier: [^\n]+\n {8}version: ([0-9.]+)\n/.exec(
    readFileSync('pnpm-lock.yaml', 'utf8'),
  )?.[1];

  it('installs nothing in the target and status jobs', () => {
    for (const job of ['target', 'status']) {
      const runs = (submit.jobs[job]?.steps ?? []).map((entry) => entry.run ?? '').join('\n');
      expect(runs, job).not.toContain('vp install');
      expect(runs, job).not.toContain('node --import tsx');
    }
  });

  it('pins every vp dlx tsx to the lockfile version', () => {
    expect(lockfileTsx).toMatch(/^\d+\.\d+\.\d+$/);
    const sources = [submitSource, read('mobile-store-submit-readiness-stores.yml')].join('\n');
    const pins = [...sources.matchAll(/vp dlx tsx@([0-9.]+) /g)].map((match) => match[1]);
    expect(pins.length).toBeGreaterThanOrEqual(4);
    expect(new Set(pins)).toEqual(new Set([lockfileTsx]));
  });

  it('runs only scripts whose imports are Node builtins or other such scripts', () => {
    const scripts = [
      'scripts/mobile-store-submit-target.ts',
      'scripts/mobile-store-submit-android.ts',
      'scripts/release-train-sync.ts',
      'scripts/lib/release-tags.ts',
      'scripts/mobile-store-android-production.ts',
      'scripts/lib/google-play-tracks.ts',
      'scripts/mobile-store-android-audit.ts',
      'scripts/mobile-auto-version-bump.ts',
    ];
    for (const script of scripts) {
      const imports = [...readFileSync(script, 'utf8').matchAll(/^import [^;]*? from '([^']+)';/gms)].map(
        (match) => match[1],
      );
      for (const source of imports) {
        expect(source.startsWith('node:') || source.startsWith('.'), `${script} imports ${source}`).toBe(true);
      }
    }
  });
});

describe('release on approval and 100% stay on the automatic path', () => {
  // The shared draft lane, the hand-run release control and the hand-run review
  // submission keep MANUAL; only mobile-store-submit.yml asks for AFTER_APPROVAL.
  it('asks for AFTER_APPROVAL only from mobile-store-submit.yml', () => {
    const askers = readdirSync('.github/workflows').filter((name) => read(name).includes('AFTER_APPROVAL'));
    expect(askers).toEqual(['mobile-store-submit.yml']);
    expect(step('submit-ios', 'Release on approval').env?.['STORE_RELEASE_TYPE']).toBe('AFTER_APPROVAL');
    expect(step('submit-ios', 'Submit for App Review').run).toContain('release_type:AFTER_APPROVAL');
    const fastfile = readFileSync('fastlane/Fastfile', 'utf8');
    const iosDraftLane = fastfile.slice(
      fastfile.indexOf('lane :draft_submission do'),
      fastfile.indexOf('lane :creatives do'),
    );
    expect(iosDraftLane).toContain('automatic_release: false,');
    expect(fastfile).toContain('release_type: (options[:release_type] || "MANUAL").to_s');
    expect(readFileSync('fastlane/lib/store_release_control.rb', 'utf8')).toContain(
      'ENV.fetch("STORE_RELEASE_TYPE", "MANUAL")',
    );
  });

  it('releases Android at 100% through Android Production Release’s own code', () => {
    const script = readFileSync('scripts/mobile-store-submit-android.ts', 'utf8');
    expect(script).toContain("import { promoteAndroidProduction } from './mobile-store-android-production';");
    expect(script.match(/rolloutPercent: 100/g)).toHaveLength(2);
    expect(script).not.toMatch(/rolloutPercent: (?!100)/);
    expect(submitSource).not.toContain('ANDROID_ROLLOUT_PERCENT');
  });
});

describe('readiness checks on merge-back PRs', () => {
  const builds = load('mobile-store-submit-readiness.yml');
  const stores = load('mobile-store-submit-readiness-stores.yml');
  const storesSource = read('mobile-store-submit-readiness-stores.yml');
  const ownTrain =
    "github.event.pull_request.head.ref == 'release/next' && github.event.pull_request.head.repo.full_name == github.repository";

  it('runs only for this repository’s own release train', () => {
    expect(flatten(builds.jobs['builds']?.if)).toBe(ownTrain);
    expect(flatten(stores.jobs['stores']?.if)).toBe(ownTrain);
  });

  it('checks builds under pull_request with no secrets or environment', () => {
    expect(Object.keys(builds.on)).toEqual(['pull_request']);
    expect(builds.permissions).toEqual({ contents: 'read', 'pull-requests': 'read' });
    expect(builds.jobs['builds']?.environment).toBeUndefined();
    expect(read('mobile-store-submit-readiness.yml')).not.toContain('secrets.');
  });

  // pull_request_target runs with Production credentials, so it must never run
  // the PR's code: one checkout, of main, and the PR head read as git data.
  it('reads store state under pull_request_target without ever checking out the PR', () => {
    expect(Object.keys(stores.on)).toEqual(['pull_request_target']);
    expect(stores.permissions).toEqual({ contents: 'read', 'pull-requests': 'read' });
    expect(stores.jobs['stores']?.environment).toBe('Production');
    const checkouts = (stores.jobs['stores']?.steps ?? []).filter((entry) =>
      entry.uses?.startsWith('actions/checkout'),
    );
    expect(checkouts).toHaveLength(1);
    expect(JSON.stringify(checkouts[0])).not.toMatch(/head|ref/);
    // PR-controlled values reach shell only through env.
    for (const entry of stores.jobs['stores']?.steps ?? []) {
      expect(entry.run ?? '', entry.name).not.toContain('${{');
    }
    expect(stores.jobs['stores']?.env?.['HEAD_SHA']).toBe('${{ github.event.pull_request.head.sha }}');
    // No node_modules cache a later trusted run could restore from.
    expect(storesSource).not.toMatch(/^\s+cache: true$/m);
    // GET-only store reads: the status lanes and the audit, never a write lane.
    expect(storesSource).not.toMatch(
      /--apply|action:submit|store_release_control|fastlane ios metadata|draft_submission/,
    );
  });
});

// ─── Executed ───────────────────────────────────────────────────────────────────

type ScriptRun = { status: number | null; stdout: string; outputs: Record<string, string> };

function runScript(script: string, env: Record<string, string>, stubs: Record<string, string> = {}): ScriptRun {
  const sandbox = mkdtempSync(join(tmpdir(), 'store-submit-step-'));
  try {
    const bin = join(sandbox, 'bin');
    mkdirSync(bin);
    for (const [command, body] of Object.entries(stubs)) {
      writeFileSync(join(bin, command), body);
      chmodSync(join(bin, command), 0o755);
    }
    const outputPath = join(sandbox, 'github-output');
    writeFileSync(outputPath, '');
    writeFileSync(join(sandbox, 'step.sh'), script);
    const result = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', join(sandbox, 'step.sh')], {
      cwd: sandbox,
      encoding: 'utf8',
      env: {
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        HOME: sandbox,
        GITHUB_OUTPUT: outputPath,
        GITHUB_REPOSITORY: 'boardsesh/boardsesh',
        ...env,
      },
    });
    const outputs: Record<string, string> = {};
    for (const line of readFileSync(outputPath, 'utf8').split('\n')) {
      const separator = line.indexOf('=');
      if (separator > 0) outputs[line.slice(0, separator)] = line.slice(separator + 1);
    }
    return { status: result.status, stdout: result.stdout, outputs };
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

describe('the decisions, executed', { timeout: 30_000 }, () => {
  const SHA = 'c'.repeat(40);
  // `gh api .../compare/...` answers $STUB_COMPARE; nothing else is expected.
  const ghStub = `#!/usr/bin/env bash\ncase "$*" in *compare*) printf '%s\\n' "$STUB_COMPARE" ;; *) exit 9 ;; esac\n`;
  const resolve = draft.jobs['release-candidate']?.steps?.find((entry) => entry.id === 'ref')?.run ?? '';

  it('pins a merge commit that is in main, and refuses one that is not', () => {
    for (const compare of ['ahead', 'identical']) {
      const run = runScript(
        resolve,
        { PINNED_RELEASE_SHA: SHA, RELEASE_BRANCH: 'main', STUB_COMPARE: compare },
        { gh: ghStub },
      );
      expect(run.status, compare).toBe(0);
      expect(run.outputs['sha']).toBe(SHA);
    }
    for (const compare of ['diverged', 'behind', '']) {
      const run = runScript(
        resolve,
        { PINNED_RELEASE_SHA: SHA, RELEASE_BRANCH: 'main', STUB_COMPARE: compare },
        { gh: ghStub },
      );
      expect(run.status, compare).not.toBe(0);
      expect(run.outputs['sha']).toBeUndefined();
    }
  });

  it('refuses a short SHA, or a pinned run from anywhere but main', () => {
    expect(
      runScript(
        resolve,
        { PINNED_RELEASE_SHA: 'c'.repeat(12), RELEASE_BRANCH: 'main', STUB_COMPARE: 'ahead' },
        { gh: ghStub },
      ).status,
    ).not.toBe(0);
    expect(
      runScript(
        resolve,
        { PINNED_RELEASE_SHA: SHA, RELEASE_BRANCH: 'release/next', STUB_COMPARE: 'ahead' },
        { gh: ghStub },
      ).status,
    ).not.toBe(0);
  });

  const requireIos = step('submit-ios', 'Require the exact verified candidate').run ?? '';
  const ready = {
    CANDIDATE_READY: 'true',
    TARGET_VERSION: '2.7.0',
    RELEASE_VERSION: '2.7.0',
    IOS_BUILD_NUMBER: '12',
    IOS_DRAFT: 'success',
    NEEDS_DRAFT: 'true',
    SUBMIT: 'true',
  };

  it('fails the iOS submission unless the draft produced a verified candidate', () => {
    expect(runScript(requireIos, ready).status).toBe(0);
    for (const broken of [
      { CANDIDATE_READY: '' },
      { CANDIDATE_READY: 'false' },
      { RELEASE_VERSION: '2.7.1' },
      { IOS_BUILD_NUMBER: '' },
      { IOS_DRAFT: 'failure' },
      { IOS_DRAFT: 'skipped' },
    ]) {
      expect(runScript(requireIos, { ...ready, ...broken }).status, JSON.stringify(broken)).not.toBe(0);
    }
    // A plan writes no draft, nor does resuming a review draft: a skipped draft is expected there.
    expect(runScript(requireIos, { ...ready, SUBMIT: 'false', IOS_DRAFT: 'skipped' }).status).toBe(0);
    expect(runScript(requireIos, { ...ready, NEEDS_DRAFT: 'false', IOS_DRAFT: 'skipped' }).status).toBe(0);
  });

  it('fails the Android release unless the draft produced a verified candidate', () => {
    const requireAndroid = step('submit-android', 'Require the exact verified candidate').run ?? '';
    const androidReady = {
      CANDIDATE_READY: 'true',
      DRAFT_VERSION: '2.7.0',
      TARGET_VERSION: '2.7.0',
      ANDROID_VERSION_CODE: '2001310',
    };
    expect(runScript(requireAndroid, androidReady).status).toBe(0);
    for (const broken of [{ CANDIDATE_READY: 'false' }, { DRAFT_VERSION: '' }, { ANDROID_VERSION_CODE: 'abc' }]) {
      expect(runScript(requireAndroid, { ...androidReady, ...broken }).status, JSON.stringify(broken)).not.toBe(0);
    }
  });
});
