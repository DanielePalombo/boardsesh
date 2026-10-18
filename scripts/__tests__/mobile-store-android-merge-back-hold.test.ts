import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  holdFromPlay,
  holdOrFailOpen,
  holdWithoutPlay,
  mergeBackHold,
  readMergeBack,
  type MergeBack,
} from '../mobile-store-android-merge-back-hold';
import { androidSubmissionStatus } from '../mobile-store-submit-android';
import type { TargetRuntime } from '../mobile-store-submit-target';

const MERGE_SHA = 'c'.repeat(40);
const mergeBack = (overrides: Partial<MergeBack> = {}): MergeBack => ({
  number: 6600,
  version: '2.7.0',
  androidVersionCodes: [2001309, 2001310],
  androidAnchored: false,
  ...overrides,
});
const release = (versionCode: number, state: string) => ({
  releaseLifecycleState: `RELEASE_LIFECYCLE_STATE_${state}`,
  activeArtifacts: [{ versionCode }],
});
afterEach(() => vi.unstubAllGlobals());

describe('holdWithoutPlay', () => {
  const base = { trainVersion: '2.7.1', mergeBack: mergeBack(), killSwitchOff: false };

  it('asks Play when a newer train version would follow an unaccepted merge-back', () => {
    expect(holdWithoutPlay(base)).toBeNull();
  });

  it.each([
    ['the kill switch is off', { killSwitchOff: true }, 'STORE_AUTO_SUBMIT is off'],
    ['nothing was merged back', { mergeBack: null }, 'Nothing has been merged back'],
    ['the build is of the merged-back version itself', { trainVersion: '2.7.0' }, 'merged-back version itself'],
    [
      'the merged-back version has no Android build',
      { mergeBack: mergeBack({ androidVersionCodes: [] }) },
      'no Android build',
    ],
    ['Google already accepted it', { mergeBack: mergeBack({ androidAnchored: true }) }, 'anchor exists'],
  ])('builds without asking Play when %s', (_case, overrides, reason) => {
    expect(holdWithoutPlay({ ...base, ...overrides })).toMatchObject({
      pending: false,
      reason: expect.stringContaining(reason),
    });
  });
});

describe('holdFromPlay', () => {
  it.each(['pending', 'deferred'] as const)('holds while the merge-back submission is %s', (status) => {
    expect(holdFromPlay(mergeBack(), { status, reason: 'Why.' })).toMatchObject({
      pending: true,
      reason: expect.stringContaining('versionCode 2001310) has not reached Play production yet'),
    });
  });

  // Done: production carries it. Blocked or superseded: holding cannot help, and
  // a rejected build is fixed by a new train build.
  it.each(['done', 'blocked', 'superseded'] as const)('builds once the merge-back is %s', (status) => {
    expect(holdFromPlay(mergeBack(), { status, reason: 'Why.' })).toMatchObject({ pending: false });
  });
});

describe('mergeBackHold', () => {
  it('reads Play only when git and GitHub cannot decide, for every build of the version', async () => {
    const readPlay = vi.fn(async () => ({ status: 'pending' as const, reason: 'Not submitted.' }));
    expect(
      await mergeBackHold({ trainVersion: '2.7.1', killSwitchOff: false, readMergeBack: () => mergeBack(), readPlay }),
    ).toMatchObject({ pending: true });
    expect(readPlay).toHaveBeenCalledWith([2001309, 2001310]);

    readPlay.mockClear();
    const readMergeBackSpy = vi.fn(() => mergeBack());
    expect(
      await mergeBackHold({ trainVersion: '2.7.1', killSwitchOff: true, readMergeBack: readMergeBackSpy, readPlay }),
    ).toMatchObject({ pending: false });
    expect(readMergeBackSpy).not.toHaveBeenCalled();
    expect(readPlay).not.toHaveBeenCalled();
  });

  it('holds against the real Play classification until production carries the build', async () => {
    const play = (production: unknown[], internal: unknown[] = [release(2001310, 'PUBLISHED')]) => {
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(new Response(JSON.stringify({ releases: production })))
        .mockResolvedValueOnce(new Response(JSON.stringify({ releases: [] })))
        .mockResolvedValueOnce(new Response(JSON.stringify({ releases: internal })));
      vi.stubGlobal('fetch', fetchMock);
    };
    const decide = () =>
      mergeBackHold({
        trainVersion: '2.7.1',
        killSwitchOff: false,
        readMergeBack: () => mergeBack(),
        readPlay: (versionCodes) => androidSubmissionStatus({ accessToken: 'secret', versionCodes }),
      });

    play([release(2001108, 'PUBLISHED'), release(2001310, 'DRAFT')]);
    expect((await decide()).pending).toBe(true);
    play([release(2001310, 'IN_REVIEW')]);
    expect((await decide()).pending).toBe(false);
    play([release(2001310, 'PUBLISHED')]);
    expect((await decide()).pending).toBe(false);
    // Internal already moved on: the merge-back is stranded, so holding helps nobody.
    play([release(2001108, 'PUBLISHED')], [release(2001400, 'PUBLISHED')]);
    expect((await decide()).pending).toBe(false);
  });
});

describe('holdOrFailOpen', () => {
  it('builds, with the cause in the reason, when anything cannot be read', async () => {
    const decision = await holdOrFailOpen(async () => {
      throw new Error('Google Play merge-back submission request returned HTTP 503 (GET /tracks/production/releases)');
    });
    expect(decision).toMatchObject({ pending: false, failedOpen: true, reason: expect.stringContaining('HTTP 503') });
    expect(await holdOrFailOpen(async () => ({ pending: true, reason: 'held' }))).toEqual({
      pending: true,
      reason: 'held',
      failedOpen: false,
    });
  });
});

describe('readMergeBack', () => {
  const runtime = (pullRequests: unknown[], tags: string[]): TargetRuntime => ({
    listMergedBackPullRequests: () => pullRequests,
    appConfigAt: (sha) => {
      if (sha !== MERGE_SHA) throw new Error(`unexpected ${sha}`);
      return "export default {\n  expo: {\n    version: '2.7.0',\n  },\n};\n";
    },
    parentCount: () => 2,
    changedPaths: () => [],
    remoteTagNames: () => tags,
  });

  it('reads the newest merge-back, its Android builds and anchor', () => {
    const merged = [
      {
        number: 6600,
        mergedAt: '2026-10-25T08:00:00Z',
        mergeCommit: { oid: MERGE_SHA },
        headRefOid: MERGE_SHA,
        isCrossRepository: false,
      },
    ];
    expect(
      readMergeBack(
        runtime(merged, [
          'build-android-v2.7.0-2001310-abcdef123456',
          'build-android-v2.7.0-2001309-abcdef123456',
          'build-ios-v2.7.0-12-abcdef123456',
        ]),
      ),
    ).toEqual({ number: 6600, version: '2.7.0', androidVersionCodes: [2001309, 2001310], androidAnchored: false });
    expect(readMergeBack(runtime(merged, ['release/android-v2.7.0-abcdef123456']))?.androidAnchored).toBe(true);
    expect(readMergeBack(runtime([], []))).toBeNull();
  });
});
