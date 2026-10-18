/// <reference types="node" />

/**
 * Picks what the automatic store submission (.github/workflows/mobile-store-submit.yml)
 * works on, and describes an open merge-back for its readiness checks. Reads git and
 * GitHub only; never touches a store.
 *
 * The target is the newest merged PR from this repository's release/next into main
 * (the "merge-back"): its merge commit, and the marketing version in
 * packages/mobile/app.config.ts at that commit. Nothing is stored between runs, so
 * every run (push, hourly, dispatch) re-derives the same target and the store-state
 * jobs decide whether anything is left to do.
 *
 * The cheap exit, before any store is asked: when both release anchors
 * (release/ios-v<version>-*, release/android-v<version>-*) exist, Apple and Google
 * have accepted the version and nothing is left to submit.
 *
 * Warnings, never failures:
 *   - the merge-back was squashed (its merge commit has one parent), so
 *     scripts/generate-changelog.ts drops the train's PRs from the changelog;
 *   - the localized release notes (iOS release_notes.txt, Play changelogs) are the
 *     same as at the previous merge-back.
 *
 * Usage:
 *   node --import tsx scripts/mobile-store-submit-target.ts                    # submit target (CI)
 *   node --import tsx scripts/mobile-store-submit-target.ts --candidate <sha>  # an open merge-back's head or merge ref
 */

import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { parseBuildTag, parseReleaseTag } from './lib/release-tags';
import {
  APP_CONFIG_PATH,
  MAIN_BRANCH,
  RELEASE_BRANCH,
  listMergedBack,
  parseSemver,
  readMarketingVersion,
  type MergedBackPullRequest,
} from './release-train-sync';

/** The localized What's New files. Unchanged since the last merge-back means stale notes. */
export const RELEASE_NOTES_PATHSPECS = [
  ':(glob)fastlane/metadata/*/release_notes.txt',
  ':(glob)fastlane/metadata/android/*/changelogs/default.txt',
] as const;

export const KILL_SWITCH_OFF = 'off';

export type SubmitMode = 'plan' | 'submit';

/**
 * PURE: plan (store reads only) or submit. `vars.STORE_AUTO_SUBMIT == 'off'` forces
 * plan for every trigger; a dispatch asks for one explicitly; push and schedule
 * submit.
 */
export function resolveSubmitMode(input: { eventName: string; requestedAction: string; killSwitch: string }): {
  mode: SubmitMode;
  reason: string;
} {
  if (input.killSwitch.trim().toLowerCase() === KILL_SWITCH_OFF) {
    return { mode: 'plan', reason: 'STORE_AUTO_SUBMIT is off: plan only, no store writes.' };
  }
  if (input.eventName === 'workflow_dispatch') {
    if (input.requestedAction !== 'plan' && input.requestedAction !== 'submit') {
      throw new Error(`Dispatch action must be plan or submit, got "${input.requestedAction}".`);
    }
    return {
      mode: input.requestedAction,
      reason: input.requestedAction === 'plan' ? 'Dispatched as a plan: store reads only.' : 'Dispatched to submit.',
    };
  }
  return { mode: 'submit', reason: `A ${input.eventName} run submits whatever is pending.` };
}

export type Anchors = { ios: boolean; android: boolean };

/** PURE: which platforms already have a release/<platform>-v<version>-* anchor. */
export function anchoredPlatforms(tagNames: readonly string[], version: string): Anchors {
  const anchors: Anchors = { ios: false, android: false };
  for (const name of tagNames) {
    const tag = parseReleaseTag(name);
    if (tag && tag.version === version) anchors[tag.platform] = true;
  }
  return anchors;
}

/** PURE: every build number tagged for the version on one platform (build-<platform>-v<version>-<n>-<fp>), ascending. */
export function buildNumbers(tagNames: readonly string[], platform: 'ios' | 'android', version: string): number[] {
  const numbers = new Set<number>();
  for (const name of tagNames) {
    const tag = parseBuildTag(name);
    if (tag && tag.platform === platform && tag.version === version) numbers.add(tag.buildNumber);
  }
  return [...numbers].sort((left, right) => left - right);
}

/** PURE: every Android versionCode tagged for the version, ascending. */
export function androidVersionCodes(tagNames: readonly string[], version: string): number[] {
  return buildNumbers(tagNames, 'android', version);
}

/** `git ls-remote` output (`<sha>\trefs/tags/<name>`, peeled `^{}` lines included) to tag names. */
export function parseLsRemoteTagNames(output: string): string[] {
  const names = new Set<string>();
  for (const line of output.split('\n')) {
    const ref = line.trim().split(/\s+/)[1];
    if (!ref?.startsWith('refs/tags/')) continue;
    names.add(ref.slice('refs/tags/'.length).replace(/\^\{\}$/, ''));
  }
  return [...names].sort();
}

/** What a run needs from git and GitHub; the CLI wires these to `git` and `gh`. */
export type TargetRuntime = {
  /** Raw `gh pr list --base main --head release/next --state merged` entries. */
  listMergedBackPullRequests(): readonly unknown[];
  appConfigAt(sha: string): string;
  parentCount(sha: string): number;
  /** Paths matching the pathspecs that differ between the two commits. */
  changedPaths(fromSha: string, toSha: string, pathspecs: readonly string[]): string[];
  /** Tag names on origin matching the `refs/tags/...` glob patterns. */
  remoteTagNames(patterns: readonly string[]): string[];
};

export type CandidateFacts = {
  version: string;
  /** The newest merge-back other than the candidate itself, if any. */
  previous: (MergedBackPullRequest & { version: string }) | null;
  /** null when there is no earlier merge-back to compare with. */
  notesChanged: boolean | null;
  anchors: Anchors;
  androidVersionCodes: number[];
  iosBuildNumbers: number[];
};

function versionAt(runtime: TargetRuntime, sha: string): string {
  return readMarketingVersion(runtime.appConfigAt(sha));
}

/** The version, release-note freshness, anchors and Android builds of one commit. */
export function describeCandidate(
  runtime: TargetRuntime,
  candidateSha: string,
  mergedBack: readonly MergedBackPullRequest[],
): CandidateFacts {
  const version = versionAt(runtime, candidateSha);
  const earlier = mergedBack.find((pullRequest) => pullRequest.mergeCommitOid !== candidateSha) ?? null;
  const previous = earlier ? { ...earlier, version: versionAt(runtime, earlier.mergeCommitOid) } : null;
  const notesChanged = previous
    ? runtime.changedPaths(previous.mergeCommitOid, candidateSha, RELEASE_NOTES_PATHSPECS).length > 0
    : null;
  const tagNames = runtime.remoteTagNames([
    `refs/tags/release/ios-v${version}-*`,
    `refs/tags/release/android-v${version}-*`,
    `refs/tags/build-ios-v${version}-*`,
    `refs/tags/build-android-v${version}-*`,
  ]);
  return {
    version,
    previous,
    notesChanged,
    anchors: anchoredPlatforms(tagNames, version),
    androidVersionCodes: androidVersionCodes(tagNames, version),
    iosBuildNumbers: buildNumbers(tagNames, 'ios', version),
  };
}

export type SubmitTarget = CandidateFacts & {
  pullRequest: MergedBackPullRequest;
  /** The merge-back was squashed or rebased: one parent. */
  squashed: boolean;
};

/**
 * The merge-back to submit: the newest one, or with `requestedVersion` the newest
 * one whose merge commit carries that version. null when nothing was merged back.
 */
export function resolveSubmitTarget(
  runtime: TargetRuntime,
  options: { requestedVersion?: string } = {},
): SubmitTarget | null {
  const mergedBack = listMergedBack(runtime.listMergedBackPullRequests());
  if (mergedBack.length === 0) return null;
  let pullRequest = mergedBack[0]!;
  const requestedVersion = options.requestedVersion?.trim();
  if (requestedVersion) {
    parseSemver(requestedVersion);
    const match = mergedBack.find((entry) => versionAt(runtime, entry.mergeCommitOid) === requestedVersion);
    if (!match) {
      throw new Error(
        `None of the last ${mergedBack.length} merge-backs carries version ${requestedVersion}; nothing to submit.`,
      );
    }
    pullRequest = match;
  }
  const facts = describeCandidate(
    runtime,
    pullRequest.mergeCommitOid,
    mergedBack.slice(mergedBack.indexOf(pullRequest) + 1),
  );
  return { ...facts, pullRequest, squashed: runtime.parentCount(pullRequest.mergeCommitOid) < 2 };
}

/**
 * PURE: whether the store jobs have anything to look at. While the kill switch is
 * off, a push plans only when it is the merge-back itself, so ordinary main
 * pushes do not each read both stores for nothing.
 */
export function shouldCheckStores(
  target: SubmitTarget | null,
  context: { eventName?: string; pushedSha?: string; killSwitchOff?: boolean } = {},
): { proceed: boolean; reason: string } {
  if (!target)
    return { proceed: false, reason: `No PR from ${RELEASE_BRANCH} into ${MAIN_BRANCH} has been merged yet.` };
  if (target.anchors.ios && target.anchors.android) {
    return {
      proceed: false,
      reason: `Apple and Google both accepted ${target.version} (release anchors exist); nothing to submit.`,
    };
  }
  if (
    context.killSwitchOff &&
    context.eventName === 'push' &&
    context.pushedSha !== target.pullRequest.mergeCommitOid
  ) {
    return {
      proceed: false,
      reason: `STORE_AUTO_SUBMIT is off and this push is not the merge-back; dispatch the workflow to plan ${target.version}.`,
    };
  }
  return {
    proceed: true,
    reason: `${target.version} from merge-back #${target.pullRequest.number} is not accepted by both stores yet; checking the stores.`,
  };
}

/** PURE: the warnings a target or open merge-back earns. */
export function candidateWarnings(facts: CandidateFacts, options: { squashed?: boolean } = {}): string[] {
  const warnings: string[] = [];
  if (options.squashed) {
    warnings.push(
      'The merge-back was squashed or rebased, not merged with a merge commit, so the changelog drops the PRs that rode the train. Still submitting.',
    );
  }
  if (facts.notesChanged === false && facts.previous) {
    warnings.push(
      `The release notes (fastlane/metadata/*/release_notes.txt and the Play changelogs) are unchanged since the previous merge-back #${facts.previous.number} (${facts.previous.version}); this version would ship the same What's New text.`,
    );
  }
  return warnings;
}

// ─── CLI ────────────────────────────────────────────────────────────────────────

function run(command: string, args: readonly string[], cwd: string): string {
  return execFileSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

export function createRuntime(options: { cwd: string; repository: string }): TargetRuntime {
  const { cwd, repository } = options;
  const git = (args: readonly string[]) => run('git', args, cwd);
  // CI checks out one commit: fetch just the commits a run reads, by SHA. A full
  // local clone fetches without --depth, which would otherwise make it shallow.
  const ensureCommit = (sha: string) => {
    if (!/^[0-9a-f]{40}$/.test(sha) && sha !== 'HEAD') throw new Error(`Not a full commit SHA: ${sha}`);
    try {
      git(['cat-file', '-e', `${sha}^{commit}`]);
    } catch {
      const shallow = git(['rev-parse', '--is-shallow-repository']).trim() === 'true';
      git(['fetch', '--quiet', '--no-tags', ...(shallow ? ['--depth=1'] : []), 'origin', sha]);
    }
  };
  return {
    listMergedBackPullRequests() {
      const output = run(
        'gh',
        [
          'pr',
          'list',
          '--repo',
          repository,
          '--base',
          MAIN_BRANCH,
          '--head',
          RELEASE_BRANCH,
          '--state',
          'merged',
          '--limit',
          '20',
          '--json',
          'number,mergedAt,mergeCommit,headRefOid,isCrossRepository',
        ],
        cwd,
      );
      const parsed: unknown = JSON.parse(output);
      if (!Array.isArray(parsed)) throw new Error('Unexpected gh pr list output: not an array.');
      return parsed;
    },
    appConfigAt(sha) {
      ensureCommit(sha);
      return git(['show', `${sha}:${APP_CONFIG_PATH}`]);
    },
    parentCount(sha) {
      ensureCommit(sha);
      // The raw commit object lists its parents even when a shallow clone has not fetched them.
      return git(['cat-file', '-p', sha])
        .split('\n')
        .filter((line) => line.startsWith('parent ')).length;
    },
    changedPaths(fromSha, toSha, pathspecs) {
      ensureCommit(fromSha);
      ensureCommit(toSha);
      return git(['diff', '--name-only', fromSha, toSha, '--', ...pathspecs])
        .split('\n')
        .filter(Boolean);
    },
    remoteTagNames(patterns) {
      return parseLsRemoteTagNames(git(['ls-remote', '--tags', 'origin', ...patterns]));
    },
  };
}

function writeOutputs(outputs: Record<string, string>): void {
  const lines = Object.entries(outputs).map(([key, value]) => `${key}=${value.replace(/\n/g, ' ')}`);
  for (const line of lines) console.log(`output: ${line}`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join('\n')}\n`);
}

function summary(markdown: string): void {
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
}

function warn(message: string): void {
  console.log(process.env.GITHUB_ACTIONS ? `::warning::${message}` : `warning: ${message}`);
  summary(`- ⚠️ ${message}`);
}

function factOutputs(facts: CandidateFacts): Record<string, string> {
  return {
    version: facts.version,
    previous_release_sha: facts.previous?.mergeCommitOid ?? '',
    previous_pr: facts.previous ? String(facts.previous.number) : '',
    previous_version: facts.previous?.version ?? '',
    notes_changed: facts.notesChanged === null ? 'unknown' : String(facts.notesChanged),
    ios_anchored: String(facts.anchors.ios),
    android_anchored: String(facts.anchors.android),
    android_version_codes: facts.androidVersionCodes.join(' '),
    // The highest iOS build of the version: what the draft attaches, unless two tags tie.
    ios_build_number: facts.iosBuildNumbers.length > 0 ? String(Math.max(...facts.iosBuildNumbers)) : '',
  };
}

function main(): number {
  const args = process.argv.slice(2);
  const candidateIndex = args.indexOf('--candidate');
  const known = candidateIndex === -1 ? args.length === 0 : args.length === 2 && candidateIndex === 0;
  if (!known) throw new Error('Usage: [--candidate <commit sha>]');
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const repository = process.env.GITHUB_REPOSITORY;
  if (!repository) throw new Error('GITHUB_REPOSITORY is required.');
  const runtime = createRuntime({ cwd: repoRoot, repository });

  if (candidateIndex === 0) {
    const candidateSha = args[1]!;
    const facts = describeCandidate(runtime, candidateSha, listMergedBack(runtime.listMergedBackPullRequests()));
    writeOutputs(factOutputs(facts));
    for (const message of candidateWarnings(facts)) warn(message);
    return 0;
  }

  const { mode, reason: modeReason } = resolveSubmitMode({
    eventName: process.env.GITHUB_EVENT_NAME ?? '',
    requestedAction: process.env.SUBMIT_ACTION ?? '',
    killSwitch: process.env.STORE_AUTO_SUBMIT ?? '',
  });
  const target = resolveSubmitTarget(runtime, { requestedVersion: process.env.REQUESTED_VERSION });
  const decision = shouldCheckStores(target, {
    eventName: process.env.GITHUB_EVENT_NAME,
    pushedSha: process.env.GITHUB_SHA,
    killSwitchOff: (process.env.STORE_AUTO_SUBMIT ?? '').trim().toLowerCase() === KILL_SWITCH_OFF,
  });
  writeOutputs({
    mode,
    proceed: String(decision.proceed),
    reason: decision.reason,
    ...(target
      ? {
          release_sha: target.pullRequest.mergeCommitOid,
          pr_number: String(target.pullRequest.number),
          squashed: String(target.squashed),
          ...factOutputs(target),
        }
      : {}),
  });
  summary(`### Store submission target\n\n- ${decision.reason}\n- Mode: **${mode}**. ${modeReason}`);
  if (target) {
    summary(
      `- Merge-back #${target.pullRequest.number} (merged ${target.pullRequest.mergedAt}), commit \`${target.pullRequest.mergeCommitOid}\`, version **${target.version}**.`,
    );
    for (const message of candidateWarnings(target, { squashed: target.squashed })) warn(message);
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exit(main());
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(process.env.GITHUB_ACTIONS ? `::error::${message}` : `[mobile-store-submit-target] ${message}`);
    process.exit(1);
  }
}
