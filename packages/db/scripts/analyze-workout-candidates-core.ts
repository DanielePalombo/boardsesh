/**
 * Pure counting logic behind analyze-workout-candidates.ts (#6232).
 *
 * The SQL side reduces every climb at a board/layout/angle to a tier on each
 * quality axis, so the filter grid (minAscents x minRating x benchmark) is
 * evaluated here, in memory, with no further database work.
 */

/** The `minAscents` thresholds the workout filters can take (0 means no filter). */
export const MIN_ASCENTS_THRESHOLDS = [0, 1, 5, 10, 50, 100] as const;
/** The `minRating` thresholds (0 means no filter). */
export const MIN_RATING_THRESHOLDS = [0, 2, 3, 3.5] as const;

/** Workout defaults today (packages/shared/playlist-generator/src/types.ts). */
export const DEFAULT_MIN_ASCENTS = 5;
export const DEFAULT_MIN_RATING = 2;

/**
 * Index of the highest threshold a value meets. A missing value (no stats
 * figure) only passes the 0 threshold, which is how the server treats it:
 * `minAscents`/`minRating` of 0 add no condition, and `NULL >= n` is not true.
 */
export function tierOf(value: number | null, thresholds: readonly number[]): number {
  let tier = 0;
  if (value === null || Number.isNaN(value)) return tier;
  thresholds.forEach((threshold, index) => {
    if (value >= threshold) tier = index;
  });
  return tier;
}

export interface TierGroup {
  /** Rounded display_difficulty, the grade the preview searches on. */
  grade: number;
  ascentsTier: number;
  ratingTier: number;
  isBenchmark: boolean;
  climbs: number;
}

export interface FilterCombo {
  minAscents: number;
  minRating: number;
  benchmarksOnly: boolean;
}

export function allFilterCombos(): FilterCombo[] {
  const combos: FilterCombo[] = [];
  for (const benchmarksOnly of [false, true]) {
    for (const minRating of MIN_RATING_THRESHOLDS) {
      for (const minAscents of MIN_ASCENTS_THRESHOLDS) {
        combos.push({ minAscents, minRating, benchmarksOnly });
      }
    }
  }
  return combos;
}

/** Climbs per grade that pass one filter combo. */
export function countByGrade(groups: readonly TierGroup[], combo: FilterCombo): Map<number, number> {
  const ascentsTier = MIN_ASCENTS_THRESHOLDS.indexOf(combo.minAscents as (typeof MIN_ASCENTS_THRESHOLDS)[number]);
  const ratingTier = MIN_RATING_THRESHOLDS.indexOf(combo.minRating as (typeof MIN_RATING_THRESHOLDS)[number]);
  const counts = new Map<number, number>();
  for (const group of groups) {
    if (group.ascentsTier < ascentsTier) continue;
    if (group.ratingTier < ratingTier) continue;
    if (combo.benchmarksOnly && !group.isBenchmark) continue;
    counts.set(group.grade, (counts.get(group.grade) ?? 0) + group.climbs);
  }
  return counts;
}

/** The plan shapes the generator produces: `perStep` climbs at each of `steps` consecutive grades ending at the target. */
export interface PlanShape {
  name: string;
  /** Grades the plan draws from: the target and the steps-1 grades below it on the scale. */
  steps: number;
  /** Climbs needed at each step grade. */
  perStep: number;
}

export const PLAN_SHAPES: readonly PlanShape[] = [
  { name: 'volume 20 at one grade', steps: 1, perStep: 20 },
  { name: 'grade focus 15', steps: 1, perStep: 15 },
  { name: 'pyramid 5 steps x 1', steps: 5, perStep: 1 },
  { name: 'ladder 5 steps x 2', steps: 5, perStep: 2 },
];

/**
 * Does the plan fill when aimed at `scale[targetIndex]`? Pyramid steps walk down
 * the board's grade scale by index (as the generator does), not by raw id, and
 * clamp at the bottom of the scale: when the target is near the bottom, the
 * missing steps repeat the lowest grade and their demand stacks there. Ladders
 * clamp slightly differently in the generator; this treats them the same way.
 */
export function planFills(
  counts: ReadonlyMap<number, number>,
  scale: readonly number[],
  targetIndex: number,
  shape: PlanShape,
): boolean {
  const demand = new Map<number, number>();
  for (let offset = 0; offset < shape.steps; offset += 1) {
    const grade = scale[Math.max(0, targetIndex - offset)];
    if (grade === undefined) return false;
    demand.set(grade, (demand.get(grade) ?? 0) + shape.perStep);
  }
  return [...demand].every(([grade, needed]) => (counts.get(grade) ?? 0) >= needed);
}

/** The board's grade scale as far as this catalogue shows it: every grade with at least one climb. */
export function gradeScale(groups: readonly TierGroup[]): number[] {
  return [...countByGrade(groups, { minAscents: 0, minRating: 0, benchmarksOnly: false }).keys()].sort(
    (first, second) => first - second,
  );
}

/**
 * The grades a climber realistically targets: the 10th to 90th percentile of
 * the unfiltered catalogue's grade distribution, inclusive, restricted to
 * grades on the scale. Extremes with a handful of climbs would otherwise
 * dominate every fill rate.
 */
export function coreGradeBand(groups: readonly TierGroup[]): number[] {
  const perGrade = countByGrade(groups, { minAscents: 0, minRating: 0, benchmarksOnly: false });
  const grades = [...perGrade.keys()].sort((first, second) => first - second);
  const total = grades.reduce((sum, grade) => sum + (perGrade.get(grade) ?? 0), 0);
  if (total === 0) return [];
  let running = 0;
  let low = grades[0];
  let high = grades[grades.length - 1];
  let lowSet = false;
  for (const grade of grades) {
    running += perGrade.get(grade) ?? 0;
    if (!lowSet && running / total >= 0.1) {
      low = grade;
      lowSet = true;
    }
    if (running / total >= 0.9) {
      high = grade;
      break;
    }
  }
  return grades.filter((grade) => grade >= low && grade <= high);
}

export interface ComboResult {
  combo: FilterCombo;
  totalClimbs: number;
  /** Median climbs per band grade. */
  medianPerGrade: number;
  /** Fewest climbs at any band grade. */
  minPerGrade: number;
  /** Share of band grades (0..1) where each plan shape fills. */
  fillRates: Record<string, number>;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((first, second) => first - second);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function evaluateCombo(groups: readonly TierGroup[], band: readonly number[], combo: FilterCombo): ComboResult {
  const counts = countByGrade(groups, combo);
  const bandCounts = band.map((grade) => counts.get(grade) ?? 0);
  const scale = gradeScale(groups);
  const fillRates: Record<string, number> = {};
  for (const shape of PLAN_SHAPES) {
    const filled = band.filter((grade) => planFills(counts, scale, scale.indexOf(grade), shape)).length;
    fillRates[shape.name] = band.length === 0 ? 0 : filled / band.length;
  }
  return {
    combo,
    totalClimbs: [...counts.values()].reduce((sum, value) => sum + value, 0),
    medianPerGrade: median(bandCounts),
    minPerGrade: bandCounts.length === 0 ? 0 : Math.min(...bandCounts),
    fillRates,
  };
}

export interface CatalogueTarget {
  boardType: string;
  layoutId: number;
  angle: number;
}

export interface CatalogueResult {
  target: CatalogueTarget;
  band: number[];
  unfilteredClimbs: number;
  benchmarkClimbs: number;
  results: ComboResult[];
}

export function evaluateCatalogue(target: CatalogueTarget, groups: readonly TierGroup[]): CatalogueResult {
  const band = coreGradeBand(groups);
  const results = allFilterCombos().map((combo) => evaluateCombo(groups, band, combo));
  const unfiltered = results.find(
    ({ combo }) => combo.minAscents === 0 && combo.minRating === 0 && !combo.benchmarksOnly,
  );
  const benchmarks = results.find(
    ({ combo }) => combo.minAscents === 0 && combo.minRating === 0 && combo.benchmarksOnly,
  );
  return {
    target,
    band,
    unfilteredClimbs: unfiltered?.totalClimbs ?? 0,
    benchmarkClimbs: benchmarks?.totalClimbs ?? 0,
    results,
  };
}

function percent(rate: number): string {
  return `${Math.round(rate * 100)}%`;
}

export function findResult(catalogue: CatalogueResult, combo: FilterCombo): ComboResult | undefined {
  return catalogue.results.find(
    (result) =>
      result.combo.minAscents === combo.minAscents &&
      result.combo.minRating === combo.minRating &&
      result.combo.benchmarksOnly === combo.benchmarksOnly,
  );
}

/** One markdown row per catalogue for a given filter combo. */
export function summaryRow(catalogue: CatalogueResult, combo: FilterCombo): string {
  const result = findResult(catalogue, combo);
  if (!result) return '';
  const { boardType, layoutId, angle } = catalogue.target;
  const band = catalogue.band.length === 0 ? '-' : `${catalogue.band[0]}-${catalogue.band[catalogue.band.length - 1]}`;
  const fills = PLAN_SHAPES.map((shape) => percent(result.fillRates[shape.name] ?? 0));
  return `| ${boardType} | ${layoutId} | ${angle} | ${band} | ${result.totalClimbs} | ${result.medianPerGrade} | ${result.minPerGrade} | ${fills.join(' | ')} |`;
}

export const SUMMARY_HEADER = [
  `| board | layout | angle | core grades | climbs | median per grade | fewest per grade | ${PLAN_SHAPES.map((shape) => shape.name).join(' | ')} |`,
  `| --- | --- | --- | --- | --- | --- | --- | ${PLAN_SHAPES.map(() => '---').join(' | ')} |`,
].join('\n');
