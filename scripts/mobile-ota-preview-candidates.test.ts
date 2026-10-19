import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  choosePreviewCandidates,
  collectCandidateReceipt,
  preparePreviewCandidates,
  runPreviewCandidates,
  resolvePreviewRuntime,
  type PreviewCandidate,
} from './mobile-ota-preview-candidates';
import { restorePreviewSource } from './mobile-ota-preview-source';
import { validatePreviewReceipt } from './mobile-ota-boot-preview';

const directories: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true }));
});
function graph() {
  const directory = mkdtempSync(join(tmpdir(), 'ota-candidates-'));
  directories.push(directory);
  const repository = join(directory, 'repository');
  mkdirSync(repository);
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: repository, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '--initial-branch=main');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.com');
  mkdirSync(join(repository, 'packages/mobile'), { recursive: true });
  writeFileSync(join(repository, 'packages/mobile/app.config.ts'), "version: '1.0.0',\n");
  writeFileSync(join(repository, 'climb.txt'), 'initial\n');
  writeFileSync(join(repository, 'resolution.txt'), 'original\n');
  mkdirSync(join(repository, 'scripts/lib'), { recursive: true });
  writeFileSync(join(repository, 'scripts/lib/eoas.ts'), "export const EOAS_PACKAGE_SPEC = 'eoas@1.0.0';\n");
  git('add', '.');
  git('commit', '-m', 'base');
  const root = git('rev-parse', 'HEAD');
  git('checkout', '-b', 'release/next');
  writeFileSync(join(repository, 'packages/mobile/app.config.ts'), "version: '1.0.1',\n");
  writeFileSync(join(repository, 'train.txt'), 'native train\n');
  git('add', '.');
  git('commit', '-m', 'train native and version');
  const train = git('rev-parse', 'HEAD');
  git('checkout', 'main');
  writeFileSync(join(repository, 'main.txt'), 'latest main\n');
  git('add', '.');
  git('commit', '-m', 'advance main');
  const main = git('rev-parse', 'HEAD');
  return { directory, repository, git, root, train, main };
}
function commitPr(fixture: ReturnType<typeof graph>, base: string) {
  fixture.git('checkout', '-b', 'feature', base);
  writeFileSync(join(fixture.repository, 'feature.txt'), 'PR change\n');
  fixture.git('add', '.');
  fixture.git('commit', '-m', 'PR only');
  return fixture.git('rev-parse', 'HEAD');
}
const fingerprint = 'c'.repeat(40);
const candidate = (targetRef: 'main' | 'release/next', runtime = fingerprint): PreviewCandidate => ({
  targetRef,
  targetSha: 'b'.repeat(40),
  status: 'ready',
  commitHash: 'a'.repeat(40),
  treeHash: 'd'.repeat(40),
  sourceBundle: targetRef === 'main' ? 'main.bundle' : 'train.bundle',
  sourceBundleSha256: 'f'.repeat(64),
  platforms: {
    ios: { status: 'ota-compatible', fingerprint: runtime.slice(0, 12), runtimeVersion: runtime },
    android: { status: 'native-change-required' },
  },
});
describe('dual-base PR preview replay', { timeout: 30_000 }, () => {
  it.each(['main', 'release/next'])('replays only PR commits from %s onto both latest bases', (baseRef) => {
    const fixture = graph();
    const baseSha = baseRef === 'main' ? fixture.main : fixture.train;
    const headSha = commitPr(fixture, baseSha);
    const candidates = preparePreviewCandidates(
      fixture.repository,
      { headSha, baseSha, baseRef, mainSha: fixture.main, trainSha: fixture.train },
      join(fixture.directory, 'candidates'),
    );
    expect(candidates.map((entry) => entry.status)).toEqual(['ready', 'ready']);
    const main = candidates[0]!;
    const train = candidates[1]!;
    expect(readFileSync(join(main.directory!, 'packages/mobile/app.config.ts'), 'utf8')).toContain('1.0.0');
    expect(readFileSync(join(train.directory!, 'packages/mobile/app.config.ts'), 'utf8')).toContain('1.0.1');
    expect(fixture.git('log', '--format=%s', `${main.targetSha}..${main.commitHash}`)).toBe(
      `OTA preview of PR ${headSha}`,
    );
    expect(fixture.git('log', '--format=%s', `${train.targetSha}..${train.commitHash}`)).toBe(
      `OTA preview of PR ${headSha}`,
    );
    expect(fixture.git('rev-parse', 'feature')).toBe(headSha);
  });
  it('preserves merge-only PR adjustments on both targets without carrying source-base changes', () => {
    const fixture = graph();
    commitPr(fixture, fixture.main);
    fixture.git('checkout', 'main');
    writeFileSync(join(fixture.repository, 'new-main-only.txt'), 'latest base content');
    fixture.git('add', '.');
    fixture.git('commit', '-m', 'advance main again');
    const latestMain = fixture.git('rev-parse', 'HEAD');
    fixture.git('checkout', 'feature');
    fixture.git('merge', '--no-commit', '--no-ff', 'main');
    writeFileSync(join(fixture.repository, 'resolution.txt'), 'merge-only PR logic');
    fixture.git('add', '.');
    fixture.git('commit', '-m', 'merge with manual adjustment');
    const headSha = fixture.git('rev-parse', 'HEAD');
    const results = preparePreviewCandidates(
      fixture.repository,
      { headSha, baseSha: latestMain, baseRef: 'main', mainSha: latestMain, trainSha: fixture.train },
      join(fixture.directory, 'candidates'),
    );
    for (const result of results) {
      expect(result.status).toBe('ready');
      expect(readFileSync(join(result.directory!, 'resolution.txt'), 'utf8')).toBe('merge-only PR logic');
      expect(readFileSync(join(result.directory!, 'feature.txt'), 'utf8')).toBe('PR change\n');
    }
    expect(readFileSync(join(results[0]!.directory!, 'new-main-only.txt'), 'utf8')).toBe('latest base content');
    expect(() => readFileSync(join(results[1]!.directory!, 'new-main-only.txt'))).toThrow();
  });
  it('keeps new base files when replaying a PR behind latest main', () => {
    const fixture = graph();
    const headSha = commitPr(fixture, fixture.main);
    fixture.git('checkout', 'main');
    writeFileSync(join(fixture.repository, 'base-added.txt'), 'keep this file');
    fixture.git('add', '.');
    fixture.git('commit', '-m', 'later base change');
    const latestMain = fixture.git('rev-parse', 'HEAD');
    const results = preparePreviewCandidates(
      fixture.repository,
      { headSha, baseSha: latestMain, baseRef: 'main', mainSha: latestMain },
      join(fixture.directory, 'candidates'),
    );
    expect(readFileSync(join(results[0]!.directory!, 'base-added.txt'), 'utf8')).toBe('keep this file');
  });
  it('resolves stable full runtime hashes under platform publish env without exposing the publish key', () => {
    const runner = vi.fn(() => fingerprint);
    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      EOO_TOKEN: 'publish-key',
      GOOGLE_MAPS_API_KEY: 'maps-key',
      EXPO_UPDATES_FINGERPRINT_OVERRIDE: 'wrong',
    };
    expect(resolvePreviewRuntime('/candidate', 'android', environment, runner as unknown as typeof execFileSync)).toBe(
      fingerprint,
    );
    expect(runner).toHaveBeenCalledTimes(2);
    const options = runner.mock.calls[0] as unknown as [string, string[], { env: NodeJS.ProcessEnv }];
    expect(options[2].env.GOOGLE_MAPS_API_KEY).toBe('maps-key');
    expect(options[2].env.EOO_TOKEN).toBeUndefined();
    expect(options[2].env.EXPO_UPDATES_FINGERPRINT_OVERRIDE).toBeUndefined();
    runner.mockClear();
    resolvePreviewRuntime('/candidate', 'ios', environment, runner as unknown as typeof execFileSync);
    expect(
      (runner.mock.calls[0] as unknown as [string, string[], { env: NodeJS.ProcessEnv }])[2].env.GOOGLE_MAPS_API_KEY,
    ).toBeUndefined();
    expect(
      resolvePreviewRuntime(
        '/candidate',
        'ios',
        environment,
        vi.fn().mockReturnValueOnce(fingerprint).mockReturnValueOnce('d'.repeat(40)) as unknown as typeof execFileSync,
      ),
    ).toBeNull();
  });
  it('prepares only main when marketing versions match', () => {
    const fixture = graph();
    const headSha = commitPr(fixture, fixture.main);
    const candidates = preparePreviewCandidates(
      fixture.repository,
      { headSha, baseSha: fixture.main, baseRef: 'main', mainSha: fixture.main, trainSha: fixture.main },
      join(fixture.directory, 'candidates'),
    );
    expect(candidates.map((entry) => entry.targetRef)).toEqual(['main']);
  });
  it('skips a conflict on one target without publishing the original head there', () => {
    const fixture = graph();
    fixture.git('checkout', 'release/next');
    writeFileSync(join(fixture.repository, 'climb.txt'), 'train conflict\n');
    fixture.git('commit', '-am', 'conflict');
    const trainSha = fixture.git('rev-parse', 'HEAD');
    const headSha = commitPr(fixture, fixture.main);
    writeFileSync(join(fixture.repository, 'climb.txt'), 'PR conflict\n');
    fixture.git('commit', '-am', 'PR conflict');
    const candidates = preparePreviewCandidates(
      fixture.repository,
      {
        headSha: fixture.git('rev-parse', 'HEAD'),
        baseSha: fixture.main,
        baseRef: 'main',
        mainSha: fixture.main,
        trainSha,
      },
      join(fixture.directory, 'candidates'),
    );
    expect(headSha).toMatch(/^[a-f0-9]{40}$/);
    expect(candidates[0]!.status).toBe('ready');
    expect(candidates[1]).toMatchObject({ status: 'conflict', platforms: {} });
    expect(candidates[1]!.commitHash).toBeUndefined();
  });
  it('continues independent target preparation after install failure and retains empty replay sources', () => {
    const fixture = graph();
    const headSha = commitPr(fixture, fixture.main);
    const source = { headSha, baseSha: fixture.main, baseRef: 'main', mainSha: fixture.main, trainSha: fixture.train };
    const scratch = join(fixture.directory, 'scratch');
    const out = join(fixture.directory, 'artifacts');
    vi.stubEnv('BRANCH', 'pr-7');
    const fakeCommand = vi.fn(
      (directory: string, binary: string, _args: string[], env: NodeJS.ProcessEnv = process.env) => {
        if (directory.endsWith('/candidates/main')) throw new Error('main install failed');
        if (binary === process.execPath)
          writeFileSync(
            env.GITHUB_OUTPUT!,
            `verdict_ios=ota-compatible\nfingerprint_ios=${fingerprint}\nverdict_android=ota-compatible\nfingerprint_android=${fingerprint}\n`,
          );
      },
    );
    runPreviewCandidates(fixture.repository, source, scratch, out, 'prepare', fakeCommand);
    const results = JSON.parse(readFileSync(join(scratch, 'candidates.json'), 'utf8')) as PreviewCandidate[];
    expect(results[0]!.status).toBe('failed');
    expect(results[1]!.status).toBe('ready');
    expect(results[1]!.sourceBundleSha256).toMatch(/^[a-f0-9]{64}$/);
    // A target containing all PR commits creates an empty replay, which still
    // has a compact retained source instead of an empty-bundle failure.
    runPreviewCandidates(
      fixture.repository,
      { ...source, mainSha: headSha, trainSha: undefined },
      join(fixture.directory, 'empty-scratch'),
      join(fixture.directory, 'empty-out'),
      'prepare',
      (_directory, binary, _args, env = process.env) => {
        if (binary === process.execPath)
          writeFileSync(env.GITHUB_OUTPUT!, `verdict_ios=ota-compatible\nfingerprint_ios=${fingerprint}\n`);
      },
    );
    const empty = JSON.parse(
      readFileSync(join(fixture.directory, 'empty-scratch/candidates.json'), 'utf8'),
    ) as PreviewCandidate[];
    expect(empty[0]).toMatchObject({
      status: 'ready',
      targetSha: headSha,
      sourceBundle: 'main.bundle',
    });
  });
  it.each(['main', 'release/next'])('prefers actual base %s when platform runtimes collide', (baseRef) => {
    const result = choosePreviewCandidates([candidate('main'), candidate('release/next')], baseRef);
    expect(result.selections).toHaveLength(1);
    expect(result.selections[0]!.candidate.targetRef).toBe(baseRef);
    expect(result.selections[0]!.platform).toBe('ios');
  });
  it('never deduplicates different full runtimes sharing the same display hash', () => {
    const main = candidate('main', 'a'.repeat(12) + 'b'.repeat(28));
    const train = candidate('release/next', 'a'.repeat(12) + 'c'.repeat(28));
    expect(main.platforms.ios!.fingerprint).toBe(train.platforms.ios!.fingerprint);
    expect(choosePreviewCandidates([main, train], 'main').selections).toHaveLength(2);
    delete main.platforms.ios!.runtimeVersion;
    expect(choosePreviewCandidates([main], 'main').selections).toHaveLength(0);
  });
  it('retains both runtime variants and skips native/unknown platforms', () => {
    const train = candidate('release/next', 'e'.repeat(40));
    train.platforms.android = { status: 'unknown' };
    expect(choosePreviewCandidates([candidate('main'), train], 'main').selections).toHaveLength(2);
  });
  it('restores exact generated source from compact bundle and detects substituted bytes', () => {
    const fixture = graph();
    const headSha = commitPr(fixture, fixture.main);
    const candidates = preparePreviewCandidates(
      fixture.repository,
      { headSha, baseSha: fixture.main, baseRef: 'main', mainSha: fixture.main },
      join(fixture.directory, 'candidates'),
    );
    const generated = candidates[0]!;
    const bundle = join(fixture.directory, 'main.bundle');
    execFileSync('git', ['bundle', 'create', bundle, 'HEAD', `^${fixture.main}`], {
      cwd: generated.directory,
      stdio: 'pipe',
    });
    const receipt = {
      version: 2,
      platforms: {
        ios: {
          candidateCommit: generated.commitHash,
          candidateTree: generated.treeHash,
          targetSha: generated.targetSha,
          sourceBundleSha256: createHash('sha256').update(readFileSync(bundle)).digest('hex'),
        },
      },
    };
    fixture.git('remote', 'add', 'origin', fixture.repository);
    restorePreviewSource(fixture.repository, receipt, 'ios', bundle);
    expect(fixture.git('rev-parse', 'HEAD^{tree}')).toBe(generated.treeHash);
    writeFileSync(bundle, 'substitution');
    expect(() => restorePreviewSource(fixture.repository, receipt, 'ios', bundle)).toThrow('hash differs');
  });
  it('attests original PR provenance separately from generated candidate identity', () => {
    const main = candidate('main');
    for (const platform of ['ios', 'android'] as const)
      main.platforms[platform] = {
        status: 'published',
        receipt: {
          platform,
          commitHash: main.commitHash!,
          branch: 'pr-7',
          runtimeVersion: fingerprint,
          bundleSha256: 'b'.repeat(64),
          updateId: '12345678-1234-1234-1234-123456789abc',
        },
      };
    const originalHead = 'e'.repeat(40);
    const receipt = collectCandidateReceipt(
      [main],
      { headSha: originalHead, baseSha: 'b'.repeat(40), baseRef: 'main', mainSha: 'b'.repeat(40) },
      { branch: 'pr-7', runId: 10, deploymentId: 20 },
    );
    expect(
      validatePreviewReceipt(receipt, { repository: 'boardsesh/boardsesh', headSha: originalHead, pullRequest: 7 }, 10),
    ).toEqual(receipt);
    expect(receipt.commitHash).toBe(originalHead);
    expect(() =>
      validatePreviewReceipt(
        { ...receipt, candidates: [] },
        { repository: 'boardsesh/boardsesh', headSha: originalHead, pullRequest: 7 },
        10,
      ),
    ).toThrow('no matching candidate');
  });
});
