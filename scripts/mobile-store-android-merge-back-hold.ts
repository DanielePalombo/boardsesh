/// <reference types="node" />

// Holds a release-train Android build while the last merge-back's Android build
// has not reached Play production yet. Runs in android-apk-rn.yml's play-review
// job, next to the review-pending check, and feeds the same `pending` output.
//
// Why: Android Production Release, which the merge-back submission
// (mobile-store-submit.yml) runs, only releases a build that Play's internal track
// still serves. After a merge-back the train moves to the next version at once,
// and that version's tester upload replaces internal about 30 minutes after its
// build starts. If the merge-back's Android release was deferred (a review was in
// progress), the next build could reach internal first and strand it. So the next
// version's build waits until production carries the merged-back build. A deferred
// version still has no build-android-v<version>-* tag, so release-train-sync.yml's
// hourly retry dispatches the build again, and it goes ahead once production has it.
//
// The hold only applies while it can help:
//   - the automatic submission is on (STORE_AUTO_SUBMIT is not `off`); with it off
//     a person releases by hand, and an open-ended hold would only stall the train;
//   - a merge-back exists, its version has a build-android-v<version>-* tag and no
//     release/android-v<version>-* anchor, and this build is of another version
//     (a hand-dispatched main rebuild of the merged-back version itself is not held);
//   - Play says the merge-back's submission is still `pending` or `deferred`
//     (mobile-store-submit-android.ts). Done, rejected, superseded, or already
//     stranded (internal moved on): holding cannot help, so the build goes ahead.
//
// GET-only, and it fails OPEN like the review check: anything it cannot read means
// "no hold", with a warning. A wrong "no" risks the race this closes; a wrong "yes"
// would hold every train build.

import { appendFileSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createAuditAccessToken } from './mobile-store-android-audit';
import { type AndroidSubmissionDecision, androidSubmissionStatus } from './mobile-store-submit-android';
import {
  KILL_SWITCH_OFF,
  androidVersionCodes,
  anchoredPlatforms,
  createRuntime,
  type TargetRuntime,
} from './mobile-store-submit-target';
import { APP_CONFIG_PATH, listMergedBack, readMarketingVersion } from './release-train-sync';

export type MergeBack = {
  number: number;
  version: string;
  /** Every build-android-v<version>-* versionCode, ascending. */
  androidVersionCodes: number[];
  androidAnchored: boolean;
};

export type HoldDecision = { pending: boolean; reason: string };

/**
 * PURE: the decision that needs no Play read, or `null` when Play has to say
 * whether the merge-back's Android build is still waiting for production.
 */
export function holdWithoutPlay(input: {
  trainVersion: string;
  mergeBack: MergeBack | null;
  killSwitchOff: boolean;
}): HoldDecision | null {
  const { trainVersion, mergeBack } = input;
  if (input.killSwitchOff) {
    return {
      pending: false,
      reason: 'STORE_AUTO_SUBMIT is off, so no merge-back is submitted automatically; not holding.',
    };
  }
  if (!mergeBack) return { pending: false, reason: 'Nothing has been merged back yet; not holding.' };
  if (trainVersion === mergeBack.version) {
    return { pending: false, reason: `This build is of ${trainVersion}, the merged-back version itself; not holding.` };
  }
  if (mergeBack.androidVersionCodes.length === 0) {
    return {
      pending: false,
      reason: `Merge-back #${mergeBack.number} (${mergeBack.version}) has no Android build; not holding.`,
    };
  }
  if (mergeBack.androidAnchored) {
    return {
      pending: false,
      reason: `Google already accepted ${mergeBack.version} (its release/android anchor exists); not holding.`,
    };
  }
  return null;
}

/** PURE: the decision once Play has classified the merge-back's Android builds. */
export function holdFromPlay(mergeBack: MergeBack, play: AndroidSubmissionDecision): HoldDecision {
  const highest = Math.max(...mergeBack.androidVersionCodes);
  if (play.status === 'pending' || play.status === 'deferred') {
    return {
      pending: true,
      reason: `Merge-back #${mergeBack.number} (${mergeBack.version}, versionCode ${highest}) has not reached Play production yet, and this build would replace it on Play internal, which Android Production Release releases from. ${play.reason}`,
    };
  }
  return {
    pending: false,
    reason: `Merge-back #${mergeBack.number} (${mergeBack.version}): ${play.status}. ${play.reason} Not holding.`,
  };
}

/** The newest merge-back, its version and its Android builds, from git and GitHub. */
export function readMergeBack(runtime: TargetRuntime): MergeBack | null {
  const newest = listMergedBack(runtime.listMergedBackPullRequests())[0];
  if (!newest) return null;
  const version = readMarketingVersion(runtime.appConfigAt(newest.mergeCommitOid));
  const tagNames = runtime.remoteTagNames([
    `refs/tags/build-android-v${version}-*`,
    `refs/tags/release/android-v${version}-*`,
  ]);
  return {
    number: newest.number,
    version,
    androidVersionCodes: androidVersionCodes(tagNames, version),
    androidAnchored: anchoredPlatforms(tagNames, version).android,
  };
}

export async function mergeBackHold(options: {
  trainVersion: string;
  killSwitchOff: boolean;
  readMergeBack: () => MergeBack | null;
  readPlay: (versionCodes: readonly number[]) => Promise<AndroidSubmissionDecision>;
}): Promise<HoldDecision> {
  const mergeBack = options.killSwitchOff ? null : options.readMergeBack();
  const early = holdWithoutPlay({
    trainVersion: options.trainVersion,
    mergeBack,
    killSwitchOff: options.killSwitchOff,
  });
  if (early) return early;
  if (!mergeBack) throw new Error('holdWithoutPlay decides whenever there is no merge-back');
  return holdFromPlay(mergeBack, await options.readPlay(mergeBack.androidVersionCodes));
}

/** Any failure to read becomes "no hold", with the cause kept in the reason. */
export async function holdOrFailOpen(
  read: () => Promise<HoldDecision>,
): Promise<HoldDecision & { failedOpen: boolean }> {
  try {
    return { ...(await read()), failedOpen: false };
  } catch (error) {
    // The git, gh and Play helpers name the command or request and its status,
    // never a credential or a response body, so the message is safe to log.
    const cause = error instanceof Error ? error.message : 'unknown error';
    return {
      pending: false,
      failedOpen: true,
      reason: `Could not tell whether the last merge-back still needs Play internal (${cause}); building anyway.`,
    };
  }
}

async function main(): Promise<number> {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const decision = await holdOrFailOpen(async () => {
    const repository = process.env['GITHUB_REPOSITORY'];
    if (!repository) throw new Error('GITHUB_REPOSITORY is not set');
    const secret = process.env['GOOGLE_PLAY_SERVICE_ACCOUNT_JSON'];
    if (!secret) throw new Error('GOOGLE_PLAY_SERVICE_ACCOUNT_JSON is not set');
    const runtime = createRuntime({ cwd: repoRoot, repository });
    return mergeBackHold({
      trainVersion: readMarketingVersion(readFileSync(join(repoRoot, APP_CONFIG_PATH), 'utf8')),
      killSwitchOff: (process.env['STORE_AUTO_SUBMIT'] ?? '').trim().toLowerCase() === KILL_SWITCH_OFF,
      readMergeBack: () => readMergeBack(runtime),
      readPlay: async (versionCodes) =>
        androidSubmissionStatus({ accessToken: await createAuditAccessToken(secret), versionCodes }),
    });
  });
  console.log(decision.failedOpen ? `::warning::${decision.reason}` : decision.reason);
  const outputPath = process.env['GITHUB_OUTPUT'];
  if (outputPath) appendFileSync(outputPath, `pending=${decision.pending}\n`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().then((exitCode) => process.exit(exitCode));
}
