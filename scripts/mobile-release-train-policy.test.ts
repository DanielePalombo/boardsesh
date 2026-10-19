import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isNewReleaseTrainCut, isRuntimeReservedByMain } from './mobile-release-train-policy';

const config = (version: string) => `export default {\n  version: '${version}',\n};\n`;

describe('release train cut notifications', () => {
  it('announces a new active marketing version, including train creation', () => {
    expect(isNewReleaseTrainCut(config('2.6.0'), config('2.7.0'), config('2.6.0'))).toBe(true);
    expect(isNewReleaseTrainCut(config('2.6.0'), config('2.7.0'))).toBe(true);
  });
  it('does not announce every native change or sync as a new release', () => {
    expect(isNewReleaseTrainCut(config('2.6.0'), config('2.7.0'), config('2.7.0'))).toBe(false);
    expect(isNewReleaseTrainCut(config('2.7.0'), config('2.7.0'), config('2.6.0'))).toBe(false);
    expect(isNewReleaseTrainCut(config('2.7.0'), config('2.7.0'))).toBe(false);
  });
});

describe('runtimes reserved by immutable binaries contained in main', () => {
  it('protects pending store runtime H after main advances to native H2', () => {
    const repo = mkdtempSync(join(tmpdir(), 'pending-store-runtime-'));
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    try {
      git('init', '--initial-branch=main');
      git('config', 'user.name', 'Runtime policy test');
      git('config', 'user.email', 'runtime-test@example.com');
      git('commit', '--allow-empty', '-m', 'Current public runtime G');
      const publicCommit = git('rev-parse', 'HEAD');
      git('commit', '--allow-empty', '-m', 'Native runtime H ready for store submission');
      const pendingRuntime = 'a'.repeat(40);
      git('tag', `build-ios-v2.7.0-42-${pendingRuntime.slice(0, 12)}`);
      git('commit', '--allow-empty', '-m', 'main advances to native runtime H2');
      const currentMain = git('rev-parse', 'HEAD');
      expect(isRuntimeReservedByMain('ios', pendingRuntime, currentMain, execFileSync, repo)).toBe(true);
      expect(isRuntimeReservedByMain('ios', pendingRuntime, publicCommit, execFileSync, repo)).toBe(false);
      expect(isRuntimeReservedByMain('android', pendingRuntime, currentMain, execFileSync, repo)).toBe(false);
      git('checkout', '-b', 'release/next', publicCommit);
      git('commit', '--allow-empty', '-m', 'Unmerged train native runtime');
      const trainRuntime = 'b'.repeat(40);
      git('tag', `build-ios-v2.8.0-43-${trainRuntime.slice(0, 12)}`);
      expect(isRuntimeReservedByMain('ios', trainRuntime, currentMain, execFileSync, repo)).toBe(false);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }, 30_000);
});
