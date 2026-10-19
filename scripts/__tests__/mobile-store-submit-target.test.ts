import { describe, expect, it } from 'vitest';

import {
  RELEASE_NOTES_PATHSPECS,
  androidVersionCodes,
  anchoredPlatforms,
  buildNumbers,
  candidateWarnings,
  describeCandidate,
  parseLsRemoteTagNames,
  resolveSubmitMode,
  resolveSubmitTarget,
  shouldCheckStores,
  type TargetRuntime,
} from '../mobile-store-submit-target';
import { listMergedBack } from '../release-train-sync';

const SHA_OLD = 'a'.repeat(40);
const SHA_PREVIOUS = 'b'.repeat(40);
const SHA_LATEST = 'c'.repeat(40);
const SHA_HEAD = 'd'.repeat(40);
const SHA_FORK = 'e'.repeat(40);

const appConfig = (version: string) => `export default {\n  expo: {\n    version: '${version}',\n  },\n};\n`;
const pullRequest = (number: number, mergedAt: string, mergeCommit: string, isCrossRepository = false) => ({
  number,
  mergedAt,
  mergeCommit: { oid: mergeCommit },
  headRefOid: mergeCommit,
  isCrossRepository,
});

type FakeOptions = {
  versions?: Record<string, string>;
  parents?: Record<string, number>;
  notesChangedBetween?: Array<[string, string]>;
  tags?: string[];
  pullRequests?: unknown[];
};

function fakeRuntime(options: FakeOptions = {}) {
  const versions = options.versions ?? { [SHA_OLD]: '2.5.0', [SHA_PREVIOUS]: '2.6.0', [SHA_LATEST]: '2.7.0' };
  const diffs: Array<{ from: string; to: string; pathspecs: readonly string[] }> = [];
  const tagQueries: Array<readonly string[]> = [];
  const runtime: TargetRuntime = {
    listMergedBackPullRequests: () =>
      options.pullRequests ?? [
        pullRequest(4845, '2026-09-01T01:07:43Z', SHA_OLD),
        pullRequest(6600, '2026-10-25T08:00:00Z', SHA_LATEST),
        pullRequest(9999, '2026-10-26T00:00:00Z', SHA_FORK, true),
        pullRequest(6193, '2026-10-07T08:51:03Z', SHA_PREVIOUS),
      ],
    appConfigAt: (sha) => {
      const version = versions[sha];
      if (!version) throw new Error(`no app.config.ts at ${sha}`);
      return appConfig(version);
    },
    parentCount: (sha) => options.parents?.[sha] ?? 2,
    changedPaths: (from, to, pathspecs) => {
      diffs.push({ from, to, pathspecs });
      const changed = (options.notesChangedBetween ?? [[SHA_PREVIOUS, SHA_LATEST]]).some(
        ([left, right]) => left === from && right === to,
      );
      return changed ? ['fastlane/metadata/en-US/release_notes.txt'] : [];
    },
    remoteTagNames: (patterns) => {
      tagQueries.push(patterns);
      return (
        options.tags ?? [
          'build-android-v2.7.0-2001310-abcdef123456',
          'build-android-v2.7.0-2001309-abcdef123456',
          'build-ios-v2.7.0-12-abcdef123456',
        ]
      );
    },
  };
  return { runtime, diffs, tagQueries };
}

describe('resolveSubmitMode', () => {
  it('submits on push and schedule, and on a dispatch that asks for it', () => {
    expect(resolveSubmitMode({ eventName: 'push', requestedAction: '', killSwitch: '' }).mode).toBe('submit');
    expect(resolveSubmitMode({ eventName: 'schedule', requestedAction: '', killSwitch: 'on' }).mode).toBe('submit');
    expect(resolveSubmitMode({ eventName: 'workflow_dispatch', requestedAction: 'submit', killSwitch: '' }).mode).toBe(
      'submit',
    );
    expect(resolveSubmitMode({ eventName: 'workflow_dispatch', requestedAction: 'plan', killSwitch: '' }).mode).toBe(
      'plan',
    );
  });

  it('plans only, for every trigger, while STORE_AUTO_SUBMIT is off', () => {
    for (const eventName of ['push', 'schedule', 'workflow_dispatch']) {
      for (const killSwitch of ['off', 'OFF', ' off ']) {
        expect(resolveSubmitMode({ eventName, requestedAction: 'submit', killSwitch })).toMatchObject({
          mode: 'plan',
          reason: expect.stringContaining('STORE_AUTO_SUBMIT'),
        });
      }
    }
  });

  it('rejects a dispatch action it does not know', () => {
    expect(() =>
      resolveSubmitMode({ eventName: 'workflow_dispatch', requestedAction: 'release', killSwitch: '' }),
    ).toThrow('plan or submit');
  });
});

describe('tags', () => {
  it('reads anchors and Android builds of exactly the version', () => {
    const tags = [
      'release/ios-v2.7.0-abcdef123456',
      'release/android-v2.7.1-abcdef123456',
      'build-android-v2.7.0-2001310-abcdef123456',
      'build-android-v2.7.0-2001309-abcdef123456',
      'build-ios-v2.7.0-12-abcdef123456',
      'build-android-v2.7.10-2001400-abcdef123456',
    ];
    expect(anchoredPlatforms(tags, '2.7.0')).toEqual({ ios: true, android: false });
    expect(androidVersionCodes(tags, '2.7.0')).toEqual([2001309, 2001310]);
    expect(buildNumbers(tags, 'ios', '2.7.0')).toEqual([12]);
    expect(buildNumbers(tags, 'ios', '2.7.1')).toEqual([]);
  });

  it('parses ls-remote output, peeled tags once', () => {
    const output = [
      `${SHA_OLD}\trefs/tags/release/ios-v2.7.0-abcdef123456`,
      `${SHA_PREVIOUS}\trefs/tags/release/ios-v2.7.0-abcdef123456^{}`,
      `${SHA_LATEST}\trefs/heads/main`,
      '',
    ].join('\n');
    expect(parseLsRemoteTagNames(output)).toEqual(['release/ios-v2.7.0-abcdef123456']);
  });
});

describe('resolveSubmitTarget', () => {
  it('targets the newest same-repository merge-back and compares notes with the one before it', () => {
    const { runtime, diffs, tagQueries } = fakeRuntime();
    const target = resolveSubmitTarget(runtime);
    expect(target).toMatchObject({
      pullRequest: { number: 6600, mergeCommitOid: SHA_LATEST },
      version: '2.7.0',
      previous: { number: 6193, mergeCommitOid: SHA_PREVIOUS, version: '2.6.0' },
      notesChanged: true,
      squashed: false,
      anchors: { ios: false, android: false },
      androidVersionCodes: [2001309, 2001310],
      iosBuildNumbers: [12],
    });
    expect(diffs).toEqual([{ from: SHA_PREVIOUS, to: SHA_LATEST, pathspecs: RELEASE_NOTES_PATHSPECS }]);
    expect(tagQueries).toEqual([
      [
        'refs/tags/release/ios-v2.7.0-*',
        'refs/tags/release/android-v2.7.0-*',
        'refs/tags/build-ios-v2.7.0-*',
        'refs/tags/build-android-v2.7.0-*',
      ],
    ]);
  });

  it('flags a squashed merge-back and unchanged notes, but still targets it', () => {
    const { runtime } = fakeRuntime({ parents: { [SHA_LATEST]: 1 }, notesChangedBetween: [] });
    const target = resolveSubmitTarget(runtime)!;
    expect(target.squashed).toBe(true);
    expect(target.notesChanged).toBe(false);
    const warnings = candidateWarnings(target, { squashed: target.squashed });
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain('changelog drops');
    expect(warnings[1]).toContain('#6193 (2.6.0)');
  });

  it('picks the newest merge-back carrying a requested version', () => {
    const { runtime } = fakeRuntime();
    expect(resolveSubmitTarget(runtime, { requestedVersion: '2.6.0' })).toMatchObject({
      pullRequest: { number: 6193 },
      version: '2.6.0',
      previous: { number: 4845, version: '2.5.0' },
    });
    expect(() => resolveSubmitTarget(runtime, { requestedVersion: '2.9.0' })).toThrow('carries version 2.9.0');
    expect(() => resolveSubmitTarget(runtime, { requestedVersion: 'v2.6' })).toThrow('major.minor.patch');
  });

  it('has nothing to compare against on the first merge-back, and nothing at all before it', () => {
    const { runtime } = fakeRuntime({ pullRequests: [pullRequest(6600, '2026-10-25T08:00:00Z', SHA_LATEST)] });
    const target = resolveSubmitTarget(runtime)!;
    expect(target.previous).toBeNull();
    expect(target.notesChanged).toBeNull();
    expect(candidateWarnings(target)).toEqual([]);
    expect(resolveSubmitTarget(fakeRuntime({ pullRequests: [] }).runtime)).toBeNull();
  });
});

describe('shouldCheckStores', () => {
  it('asks the stores until both release anchors exist', () => {
    const target = resolveSubmitTarget(fakeRuntime().runtime)!;
    expect(shouldCheckStores(target).proceed).toBe(true);
    expect(shouldCheckStores({ ...target, anchors: { ios: true, android: false } }).proceed).toBe(true);
    expect(shouldCheckStores({ ...target, anchors: { ios: true, android: true } })).toMatchObject({
      proceed: false,
      reason: expect.stringContaining('both accepted 2.7.0'),
    });
    expect(shouldCheckStores(null).proceed).toBe(false);
  });

  it('plans only on the merge-back push itself while the kill switch is off', () => {
    const target = resolveSubmitTarget(fakeRuntime().runtime)!;
    const off = { killSwitchOff: true };
    expect(shouldCheckStores(target, { ...off, eventName: 'push', pushedSha: SHA_LATEST }).proceed).toBe(true);
    expect(shouldCheckStores(target, { ...off, eventName: 'push', pushedSha: SHA_HEAD })).toMatchObject({
      proceed: false,
      reason: expect.stringContaining('not the merge-back'),
    });
    expect(shouldCheckStores(target, { ...off, eventName: 'workflow_dispatch' }).proceed).toBe(true);
    // Switched on, every push retries whatever is pending.
    expect(shouldCheckStores(target, { eventName: 'push', pushedSha: SHA_HEAD }).proceed).toBe(true);
  });
});

describe('describeCandidate', () => {
  it('compares an open merge-back with the newest merge-back before it', () => {
    const { runtime, diffs } = fakeRuntime({
      versions: { [SHA_HEAD]: '2.8.0', [SHA_LATEST]: '2.7.0' },
      notesChangedBetween: [],
    });
    const mergedBack = listMergedBack(runtime.listMergedBackPullRequests());
    const facts = describeCandidate(runtime, SHA_HEAD, mergedBack);
    expect(facts).toMatchObject({
      version: '2.8.0',
      previous: { number: 6600, version: '2.7.0' },
      notesChanged: false,
    });
    expect(diffs[0]).toMatchObject({ from: SHA_LATEST, to: SHA_HEAD });
    expect(candidateWarnings(facts)[0]).toContain('unchanged since the previous merge-back #6600');
  });
});
