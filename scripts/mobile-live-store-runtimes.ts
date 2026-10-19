/// <reference types="node" />

import { execFileSync } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  createAppStoreConnectJwt,
  decodePrivateKey,
  getAcceptedGoogleProductionBuilds,
  getAppStoreVersions,
  parseGoogleServiceAccount,
  resolveAppId,
  type AcceptedBuild,
  type AppStoreVersionResource,
  type JsonApiCollectionResponse,
} from './mobile-auto-version-bump.ts';
import { formatBuildTag, pickExactBuildTag } from './lib/release-tags.ts';
import { parseLiveStoreRuntimes, type LiveStoreRuntimes, type MobilePlatform } from './lib/mobile-release-policy.ts';

export const PUBLIC_IOS_STATE = 'READY_FOR_DISTRIBUTION';
export const PUBLIC_ANDROID_STATE = 'RELEASE_LIFECYCLE_STATE_PUBLISHED';

/** Unlike approval anchoring, every publicly offered binary needs exact build evidence. */
export function mapPublicIosBuilds(response: JsonApiCollectionResponse<AppStoreVersionResource>): AcceptedBuild[] {
  const builds = new Map(
    (response.included ?? [])
      .filter((included) => included.type === 'builds')
      .map((included) => [included.id, included.attributes?.version]),
  );
  return response.data
    .filter((version) => version.attributes?.appVersionState === PUBLIC_IOS_STATE)
    .map((version) => {
      const versionString = version.attributes?.versionString;
      const attachedBuild = version.relationships?.build?.data;
      const rawBuildNumber = attachedBuild?.type === 'builds' ? builds.get(attachedBuild.id) : undefined;
      if (
        typeof versionString !== 'string' ||
        !/^\d+\.\d+\.\d+$/.test(versionString) ||
        typeof rawBuildNumber !== 'string' ||
        !/^[1-9]\d*$/.test(rawBuildNumber) ||
        !Number.isSafeInteger(Number(rawBuildNumber))
      ) {
        throw new Error(`Public iOS version ${version.id} has no exact build identity`);
      }
      return { platform: 'ios', versionString, buildNumber: Number(rawBuildNumber), state: PUBLIC_IOS_STATE };
    });
}

export function resolveLiveStoreRuntimes(
  publicBuilds: readonly AcceptedBuild[],
  tags: readonly string[],
  resolveCommit: (tag: string) => string,
  now = Date.now(),
): LiveStoreRuntimes {
  const platformRuntime = (platform: MobilePlatform) => {
    const publishedState = platform === 'ios' ? PUBLIC_IOS_STATE : PUBLIC_ANDROID_STATE;
    const builds = publicBuilds.filter((build) => build.platform === platform && build.state === publishedState);
    if (builds.length === 0) throw new Error(`No publicly released ${platform} build; refusing OTA routing`);
    const resolved = builds.map((build) => {
      const tag = pickExactBuildTag(tags, platform, build.buildNumber, build.versionString ?? undefined);
      if (!tag) throw new Error(`No unique immutable ${platform} build tag for store build ${build.buildNumber}`);
      const fullFingerprints = tags.filter((name) =>
        new RegExp(`^fingerprint-${platform}-${tag.shortFp}[0-9a-f]{28}$`).test(name),
      );
      if (fullFingerprints.length !== 1) {
        throw new Error(`No unique full ${platform} fingerprint for store build ${build.buildNumber}`);
      }
      const buildTag = formatBuildTag(platform, tag.version, tag.buildNumber, tag.shortFp);
      return {
        version: tag.version,
        buildNumber: tag.buildNumber,
        buildTag,
        runtimeVersion: fullFingerprints[0]!.slice(`fingerprint-${platform}-`.length),
        commit: resolveCommit(buildTag),
      };
    });
    // Version codes are monotonic. iOS marketing versions take precedence over build numbers.
    resolved.sort((left, right) => {
      if (platform === 'ios') {
        const leftVersion = left.version.split('.').map(Number);
        const rightVersion = right.version.split('.').map(Number);
        for (let index = 0; index < 3; index += 1) {
          const difference = rightVersion[index]! - leftVersion[index]!;
          if (difference !== 0) return difference;
        }
      }
      return right.buildNumber - left.buildNumber;
    });
    return { ...resolved[0]!, protectedRuntimeVersions: [...new Set(resolved.map((build) => build.runtimeVersion))] };
  };
  return parseLiveStoreRuntimes(
    {
      schemaVersion: 1,
      checkedAt: new Date(now).toISOString(),
      ios: platformRuntime('ios'),
      android: platformRuntime('android'),
    },
    now,
  );
}

function requiredEnv(name: string): string {
  const configured = process.env[name];
  if (!configured?.trim()) throw new Error(`Missing required env var: ${name}`);
  return configured;
}

async function main(): Promise<void> {
  let ios: AcceptedBuild[];
  let android: AcceptedBuild[];
  try {
    const token = createAppStoreConnectJwt({
      keyId: requiredEnv('APP_STORE_CONNECT_API_KEY_ID'),
      issuerId: requiredEnv('APP_STORE_CONNECT_ISSUER_ID'),
      privateKey: decodePrivateKey(requiredEnv('APP_STORE_CONNECT_API_KEY_BASE64')),
    });
    const appId = await resolveAppId(token);
    [ios, android] = await Promise.all([
      getAppStoreVersions(token, appId, [PUBLIC_IOS_STATE]).then(mapPublicIosBuilds),
      getAcceptedGoogleProductionBuilds(parseGoogleServiceAccount(requiredEnv('GOOGLE_PLAY_SERVICE_ACCOUNT_JSON'))),
    ]);
  } catch {
    // Store authentication and response bodies are never copied into Actions logs.
    throw new Error('Could not read exact public store builds; check Production store credentials and API responses');
  }
  const tags = execFileSync('git', ['tag', '--list'], { encoding: 'utf8' }).trim().split('\n');
  const live = resolveLiveStoreRuntimes([...ios, ...android], tags, (tag) =>
    execFileSync('git', ['rev-parse', `${tag}^{commit}`], { encoding: 'utf8' }).trim(),
  );
  const json = JSON.stringify(live);
  const outputIndex = process.argv.indexOf('--out');
  if (outputIndex >= 0) {
    const outputPath = process.argv[outputIndex + 1];
    if (!outputPath || outputPath.startsWith('--')) throw new Error('--out needs a filename');
    writeFileSync(outputPath, `${json}\n`);
  }
  if (process.env['GITHUB_OUTPUT']) appendFileSync(process.env['GITHUB_OUTPUT'], `live_runtimes=${json}\n`);
  console.log(json);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'Live store runtime resolution failed');
    process.exitCode = 1;
  });
}
