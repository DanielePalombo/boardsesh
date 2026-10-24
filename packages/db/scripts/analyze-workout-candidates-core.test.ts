import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  PLAN_SHAPES,
  allFilterCombos,
  coreGradeBand,
  countByGrade,
  evaluateCatalogue,
  planFills,
  tierOf,
  type TierGroup,
} from './analyze-workout-candidates-core.js';

const group = (grade: number, climbs: number, overrides: Partial<TierGroup> = {}): TierGroup => ({
  grade,
  ascentsTier: 0,
  ratingTier: 0,
  isBenchmark: false,
  climbs,
  ...overrides,
});

describe('tierOf', () => {
  it('returns the index of the highest threshold met', () => {
    assert.equal(tierOf(7, [0, 1, 5, 10]), 2);
    assert.equal(tierOf(10, [0, 1, 5, 10]), 3);
    assert.equal(tierOf(3.4, [0, 2, 3, 3.5]), 2);
  });

  it('puts a missing value on tier 0 so it only passes the unfiltered threshold', () => {
    assert.equal(tierOf(null, [0, 1, 5]), 0);
  });
});

describe('countByGrade', () => {
  const groups = [
    group(20, 10),
    group(20, 4, { ascentsTier: 2, ratingTier: 1 }),
    group(20, 2, { ascentsTier: 2, ratingTier: 1, isBenchmark: true }),
  ];

  it('counts everything at 0/0', () => {
    const counts = countByGrade(groups, { minAscents: 0, minRating: 0, benchmarksOnly: false });
    assert.equal(counts.get(20), 16);
  });

  it('applies ascents and rating tiers together', () => {
    const counts = countByGrade(groups, { minAscents: 5, minRating: 2, benchmarksOnly: false });
    assert.equal(counts.get(20), 6);
  });

  it('keeps benchmarks only when asked', () => {
    const counts = countByGrade(groups, { minAscents: 0, minRating: 0, benchmarksOnly: true });
    assert.equal(counts.get(20), 2);
  });
});

describe('planFills', () => {
  const [volume, , pyramid] = PLAN_SHAPES;

  it('needs the full count at one grade for a volume plan', () => {
    const counts = new Map([[20, 19]]);
    assert.equal(planFills(counts, [20], 0, volume), false);
    assert.equal(planFills(new Map([[20, 20]]), [20], 0, volume), true);
  });

  it('walks pyramid steps down the scale by index, skipping ids the board does not use', () => {
    const scale = [11, 13, 15, 17, 19];
    const counts = new Map(scale.map((grade) => [grade, 1] as [number, number]));
    assert.equal(planFills(counts, scale, 4, pyramid), true);
    assert.equal(planFills(counts, scale, 3, pyramid), false, 'index 3 needs 2 climbs at the lowest grade');
  });

  it('stacks the missing steps on the lowest grade when the target sits near the bottom', () => {
    const scale = [11, 13, 15];
    assert.equal(
      planFills(
        new Map([
          [11, 3],
          [13, 1],
          [15, 1],
        ]),
        scale,
        2,
        pyramid,
      ),
      true,
    );
    assert.equal(
      planFills(
        new Map([
          [11, 2],
          [13, 1],
          [15, 1],
        ]),
        scale,
        2,
        pyramid,
      ),
      false,
    );
  });
});

describe('evaluateCatalogue', () => {
  it('keeps a sparse catalogue from filling a volume plan and reports it', () => {
    const groups = [group(10, 30), group(11, 30), group(12, 5, { ascentsTier: 3, ratingTier: 2 })];
    const result = evaluateCatalogue({ boardType: 'x', layoutId: 1, angle: 40 }, groups);
    assert.equal(result.results.length, allFilterCombos().length);
    assert.equal(result.unfilteredClimbs, 65);
    assert.equal(result.benchmarkClimbs, 0);
  });

  it('builds the core band from the 10th to 90th percentile of grades', () => {
    const groups = [group(1, 1), group(2, 98), group(3, 1)];
    assert.deepEqual(coreGradeBand(groups), [2]);
  });
});
