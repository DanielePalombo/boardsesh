import { resolve } from 'node:path';
import { SHOWCASE_FPS, SHOWCASE_STAGE_DIR, type ShowcaseTakeId } from './contract';
import type { FootageRange, StageTake } from './render';
import type { ShowcaseScenePlan } from './timeline';

export const STORE_SEARCH_LOCALES = ['en-US', 'es', 'fr', 'de'] as const;
export type StoreSearchLocale = (typeof STORE_SEARCH_LOCALES)[number];
export const STORE_SEARCH_VARIANTS = ['default', 'kilter', 'tension', 'moonboard', 'spray'] as const;
export type StoreSearchVariant = (typeof STORE_SEARCH_VARIANTS)[number];
export const STORE_SEARCH_CROSSFADE_FRAMES = 15;
export const storeSearchCopyPath = (locale: StoreSearchLocale): string =>
  resolve(SHOWCASE_STAGE_DIR, `search-copy.${locale}.json`);

export type StoreSearchCopy = Readonly<Record<string, string>>;

/** Caption-only creative copy. Two lines; no logo, price, platform, URL or donation copy. */
export function storeSearchCopyProblems(copy: StoreSearchCopy): string[] {
  const problems: string[] = [];
  for (const [key, caption] of Object.entries(copy)) {
    const lines = caption.replaceAll('*', '').split('\n');
    if (lines.length > 2) problems.push(`${key}: more than two lines`);
    if (lines.some((line) => line.length > 20)) problems.push(`${key}: line exceeds 20 characters`);
    if (/boardsesh|android|ios|https?:|www\.|donat|gratis|free|€/i.test(caption))
      problems.push(`${key}: prohibited store creative copy`);
    const brands = caption.match(/Kilter|Tension|MoonBoard/g) ?? [];
    if (new Set(brands).size > 1) problems.push(`${key}: multiple manufacturer names`);
  }
  return problems;
}

const PILE: readonly ShowcaseTakeId[] = ['boards-kilter', 'boards-spray', 'boards-moonboard'];
const beat = (
  id: ShowcaseScenePlan['id'],
  caption: string,
  frames: number,
  takes?: readonly ShowcaseTakeId[],
  optional = false,
): ShowcaseScenePlan => ({
  id,
  caption,
  frames,
  plain: true,
  optional,
  ...(takes ? { takes } : {}),
});

/** Explicit take lists prevent a named CPP from inheriting the legacy Kilter pile or session. */
export function storeSearchPlan(variant: StoreSearchVariant): readonly ShowcaseScenePlan[] {
  if (variant === 'default')
    return [
      beat('boards', 'boards', 150, PILE),
      beat('spray', 'spray', 150),
      beat('crew', 'crew', 150),
      beat('lock-screen', 'island', 150),
    ];
  if (variant === 'kilter')
    return [
      beat('boards', 'kilter', 90, ['boards-kilter']),
      beat('log', 'kilterLog', 90),
      beat('boards', 'boards', 90, PILE),
      beat('crew', 'friends', 90),
      beat('lock-screen', 'island', 90),
    ];
  if (variant === 'tension')
    return [
      beat('boards', 'tension', 105, ['boards-tension']),
      beat('log', 'tensionLog', 150),
      beat('crew', 'tensionFriends', 105),
      beat('boards', 'climbHolds', 90, ['boards-tension']),
    ];
  if (variant === 'moonboard')
    return [
      beat('boards', 'moonboard', 90, ['boards-moonboard']),
      beat('log', 'moonboardCsv', 90, ['moonboard-import']),
      beat('wall', 'moonboardGrade', 120, ['moonboard-filter']),
      beat('boards', 'climbHolds', 150, ['boards-moonboard']),
    ];
  return [
    beat('spray', 'spraySet', 90),
    beat('spray', 'photo', 90),
    beat('log', 'sends', 90),
    beat('boards', 'gymBoards', 90, ['boards-spray', 'boards-kilter', 'boards-moonboard']),
    beat('spray', 'sprayNext', 90),
  ];
}

/** Required footage per cut, plus optional beat footage; no fallback to another variant or locale. */
export const storeSearchTakeIds = (variant: StoreSearchVariant): ShowcaseTakeId[] => [
  ...new Set(
    storeSearchPlan(variant).flatMap(
      (scene) => scene.takes ?? (scene.id === 'outro' ? [] : [scene.id as ShowcaseTakeId]),
    ),
  ),
];

/** Verify fresh native provenance before exposing any frame to a localized cut. */
export function storeSearchRecordingProblems(
  metadata: Readonly<{
    takeId?: string;
    locale?: string;
    kind?: string;
    platform?: string;
    recordedAt?: string;
    validated?: boolean;
    presentation?: string;
    boardKind?: string;
  }>,
  takeId: ShowcaseTakeId,
  locale: StoreSearchLocale,
  variant: StoreSearchVariant,
): string[] {
  const problems: string[] = [];
  if (metadata.validated !== true) problems.push('recording has not passed native validation');
  if (metadata.takeId !== takeId) problems.push(`recording take ${metadata.takeId ?? 'missing'}, expected ${takeId}`);
  if (metadata.locale !== locale) problems.push(`recording locale ${metadata.locale ?? 'missing'}, expected ${locale}`);
  const sourceKind = variant === 'default' && takeId === 'lock-screen' ? 'kilter' : variant;
  if (metadata.kind !== sourceKind)
    problems.push(`recording variant ${metadata.kind ?? 'missing'}, expected ${sourceKind}`);
  if (metadata.platform !== 'ios') problems.push('Apple creative requires a native iOS recording');
  const crewFamily =
    takeId === 'crew'
      ? variant === 'default' || variant === 'kilter'
        ? 'kilter'
        : variant === 'tension'
          ? 'tension'
          : undefined
      : undefined;
  const boardFamily = takeId.startsWith('boards-')
    ? takeId.slice('boards-'.length)
    : takeId.startsWith('moonboard-')
      ? 'moonboard'
      : takeId === 'spray'
        ? 'spray'
        : crewFamily;
  if (boardFamily && metadata.boardKind !== boardFamily)
    problems.push(`native board ${metadata.boardKind ?? 'missing'}, expected ${boardFamily}`);

  if (takeId === 'lock-screen' && (variant === 'kilter' || variant === 'default')) {
    if (metadata.presentation !== 'live-activity-card')
      problems.push('Kilter ending requires a native Live Activity card crop');
    if (metadata.boardKind !== 'kilter') problems.push('Live Activity must show the actual Kilter board');
  }
  if (!metadata.recordedAt || !Number.isFinite(Date.parse(metadata.recordedAt)))
    problems.push('missing recording timestamp');
  return problems;
}

/** Required feature beats cannot disappear into a shorter, misleading cut. */
export function storeSearchRequiredFootageProblems(
  variant: StoreSearchVariant,
  available: ReadonlySet<ShowcaseTakeId>,
): string[] {
  return storeSearchPlan(variant).flatMap((scene) => {
    if (scene.optional) return [];
    const required = scene.takes ?? [scene.id as ShowcaseTakeId];
    if (scene.id === 'boards' && required.length > 1 && required.some((takeId) => available.has(takeId))) return [];
    return required
      .filter((takeId) => !available.has(takeId))
      .map((takeId) => `Missing required native take: ${takeId}`);
  });
}

/** Scene-specific source ranges keep repeated native takes from sharing the last edit. */
export function storeSearchTakeSegments(
  variant: StoreSearchVariant,
  caption: string,
  takeId: ShowcaseTakeId,
  sceneFrames: number,
  take: Pick<StageTake, 'frameCount' | 'presentation' | 'editorialStartSeconds'>,
  marks: Readonly<Record<string, number>>,
): readonly FootageRange[] {
  const { frameCount } = take;
  const marked = (name: string): number => {
    const seconds = marks[name];
    if (!Number.isFinite(seconds) || seconds < 0 || seconds * SHOWCASE_FPS >= frameCount)
      throw new Error(`${takeId}: missing or unavailable ${name}; re-record ${variant}`);
    return seconds;
  };
  if (!Number.isInteger(frameCount) || frameCount < 2) throw new Error(`${takeId}: missing native frames`);
  if (variant === 'spray' && takeId === 'spray') {
    const firstNext = marked('next-1');
    const secondNext = marked('next-2');
    if (firstNext <= 1.4 || secondNext - firstNext <= 2 || (secondNext + 0.8) * SHOWCASE_FPS >= frameCount)
      throw new Error('spray: native opening, second Next and settled result must all be available');
    if (caption === 'spraySet' || caption === 'photo') return [[SHOWCASE_FPS, SHOWCASE_FPS + 1, sceneFrames]];
    if (caption === 'sprayNext') return [[Math.round((secondNext - 2) * SHOWCASE_FPS), frameCount]];
  }
  if ((variant === 'moonboard' || variant === 'tension') && takeId === `boards-${variant}`) {
    if (frameCount <= SHOWCASE_FPS) throw new Error(`${variant}: native hold map is unavailable`);
    return [[SHOWCASE_FPS, SHOWCASE_FPS + 1, sceneFrames]];
  }
  let mark: string | undefined;
  if (takeId === 'log')
    mark = variant === 'kilter' ? 'filter-kilter' : variant === 'tension' ? 'filter-tension' : 'scrolled';
  if (takeId === 'lock-screen')
    mark = take.presentation === 'live-activity-card' ? 'activity-ready' : 'island-expanded';
  if (takeId === 'crew') mark = 'row-landed';
  if (takeId === 'spray') mark = 'next-1';
  if (takeId === 'moonboard-import') mark = 'csv-import-entry';
  if (takeId === 'moonboard-filter') mark = 'grade-filter-shown';
  const seconds = mark ? marked(mark) : undefined;
  const from =
    take.presentation === 'live-activity-card' && take.editorialStartSeconds !== undefined
      ? Math.round(take.editorialStartSeconds * SHOWCASE_FPS)
      : seconds !== undefined
        ? Math.max(0, Math.round((seconds - 0.4) * SHOWCASE_FPS))
        : SHOWCASE_FPS;
  if (!Number.isInteger(from) || from < 0 || from >= frameCount)
    throw new Error(`${takeId}: unavailable native selection`);
  return [[from, frameCount]];
}
