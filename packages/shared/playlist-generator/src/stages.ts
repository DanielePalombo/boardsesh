// A workout as an ordered list of stages, and the carrier that tracks which
// queue items belong to which stage once the plan has been filled with climbs.
// Pure TS and JSON-serialisable: plans and runs are persisted by the apps.

import { generateWarmUp, generateWorkoutPlan } from './generate';
import type { GeneratorGradeScale, GeneratorOptions, PlannedClimbSlot, WarmUpType, WorkoutType } from './types';

// Stage kinds use the partner API block type names (docs/partner-api.md, "Blocks"),
// so `onTheMinute`, `fourByFour` and `limitBouldering` can join without renames.
export type WorkoutStageKind = 'warmUp' | WorkoutType;

/** Warm-up length for a warm-up stage. `'none'` is expressed by leaving the stage out. */
export type WarmUpStageType = Exclude<WarmUpType, 'none'>;

/** Climbs stepping up to the target grade of the stage that follows it. */
export type WarmUpStage = {
  id: string;
  kind: 'warmUp';
  warmUpType: WarmUpStageType;
};

/** Generator options for one workout type, with warm-up handled by its own stage. */
export type StageGeneratorOptions<Kind extends WorkoutType = WorkoutType> = Extract<
  GeneratorOptions,
  { type: Kind }
> & {
  warmUp: 'none';
};

type WorkoutStageByKind = {
  [Kind in WorkoutType]: { id: string; kind: Kind; options: StageGeneratorOptions<Kind> };
};

/** A main-set stage. `kind` always equals `options.type`. */
export type WorkoutMainStage = WorkoutStageByKind[WorkoutType];

export type WorkoutStage = WarmUpStage | WorkoutMainStage;

export type WorkoutPlan = { stages: WorkoutStage[] };

export type StagedSlot = PlannedClimbSlot & { stageId: string };

export type StageIdFactory = (stagePosition: number) => string;

const defaultStageId: StageIdFactory = (stagePosition) => `stage-${stagePosition}`;

export const isWarmUpStage = (stage: WorkoutStage): stage is WarmUpStage => stage.kind === 'warmUp';

const toMainStage = (options: GeneratorOptions, id: string): WorkoutMainStage => {
  switch (options.type) {
    case 'volume':
      return { id, kind: 'volume', options: { ...options, warmUp: 'none' } };
    case 'pyramid':
      return { id, kind: 'pyramid', options: { ...options, warmUp: 'none' } };
    case 'ladder':
      return { id, kind: 'ladder', options: { ...options, warmUp: 'none' } };
    case 'gradeFocus':
      return { id, kind: 'gradeFocus', options: { ...options, warmUp: 'none' } };
    default: {
      const exhaustiveOptions: never = options;
      return exhaustiveOptions;
    }
  }
};

/**
 * Turns today's single-type generator selection into a plan: a warm-up stage
 * (when one was picked) followed by the workout itself. Ids default to
 * `stage-<position>` so tests and React keys stay stable.
 */
export const planFromGeneratorOptions = (
  options: GeneratorOptions,
  makeId: StageIdFactory = defaultStageId,
): WorkoutPlan => {
  const stages: WorkoutStage[] = [];
  if (options.warmUp !== 'none') {
    stages.push({ id: makeId(stages.length), kind: 'warmUp', warmUpType: options.warmUp });
  }
  stages.push(toMainStage(options, makeId(stages.length)));
  return { stages };
};

/**
 * Generates every stage's slots in plan order. `index` runs across the whole
 * plan, so a warm-up plus one workout yields exactly what `generateWorkoutPlan`
 * yields for the same options. A warm-up stage takes its target grade from the
 * stage right after it; with no workout stage there it generates nothing.
 */
export const generateStagedPlan = (plan: WorkoutPlan, grades: GeneratorGradeScale): StagedSlot[] => {
  const stagedSlots: StagedSlot[] = [];

  plan.stages.forEach((stage, stagePosition) => {
    let stageSlots: PlannedClimbSlot[];
    if (isWarmUpStage(stage)) {
      const followingStage = plan.stages[stagePosition + 1];
      stageSlots =
        followingStage && !isWarmUpStage(followingStage)
          ? generateWarmUp(followingStage.options.targetGrade, stage.warmUpType, grades)
          : [];
    } else {
      // Force `warmUp: 'none'` in case persisted data carries an older value.
      stageSlots = generateWorkoutPlan({ ...stage.options, warmUp: 'none' }, grades);
    }

    const indexOffset = stagedSlots.length;
    for (const slot of stageSlots) {
      stagedSlots.push({ ...slot, index: indexOffset + slot.index, stageId: stage.id });
    }
  });

  return stagedSlots;
};

// ---------------------------------------------------------------------------
// Run carrier: which queue items belong to which stage.
// ---------------------------------------------------------------------------

export type WorkoutRunStage = { id: string; kind: WorkoutStageKind; itemUuids: string[] };

/** Stages in workout order. A stage with no items is never kept. */
export type WorkoutRun = { stages: WorkoutRunStage[] };

/** Groups queue-item uuids by stage, in plan order. Entries for unknown stages are dropped. */
export const buildWorkoutRun = (
  entries: ReadonlyArray<{ uuid: string; stageId: string }>,
  plan: WorkoutPlan,
): WorkoutRun => {
  const uuidsByStageId = new Map<string, string[]>();
  for (const { uuid, stageId } of entries) {
    const stageUuids = uuidsByStageId.get(stageId);
    if (stageUuids) {
      stageUuids.push(uuid);
    } else {
      uuidsByStageId.set(stageId, [uuid]);
    }
  }

  const stages: WorkoutRunStage[] = [];
  for (const stage of plan.stages) {
    const itemUuids = uuidsByStageId.get(stage.id);
    if (itemUuids && itemUuids.length > 0) {
      stages.push({ id: stage.id, kind: stage.kind, itemUuids });
    }
  }
  return { stages };
};

/**
 * Adds a stage's items to the end of the run. A stage id already in the run
 * gets the items appended to it instead. Uuids already in the run are skipped,
 * and when nothing is left to add the same run object comes back.
 */
export const appendStageToRun = (
  run: WorkoutRun,
  stage: { id: string; kind: WorkoutStageKind },
  uuids: readonly string[],
): WorkoutRun => {
  const uuidsInRun = new Set(run.stages.flatMap((runStage) => runStage.itemUuids));
  const newUuids = uuids.filter((uuid, position) => !uuidsInRun.has(uuid) && uuids.indexOf(uuid) === position);
  if (newUuids.length === 0) return run;

  const existingPosition = run.stages.findIndex((runStage) => runStage.id === stage.id);
  if (existingPosition < 0) {
    return { stages: [...run.stages, { id: stage.id, kind: stage.kind, itemUuids: newUuids }] };
  }
  return {
    stages: run.stages.map((runStage, position) =>
      position === existingPosition ? { ...runStage, itemUuids: [...runStage.itemUuids, ...newUuids] } : runStage,
    ),
  };
};

/**
 * Drops uuids that left the queue and any stage left empty. Returns the same
 * run object when nothing changed, so it is safe inside a state setter.
 */
export const pruneRun = (run: WorkoutRun, queueUuids: readonly string[]): WorkoutRun => {
  const queued = new Set(queueUuids);
  let changed = false;
  const stages: WorkoutRunStage[] = [];

  for (const runStage of run.stages) {
    const keptUuids = runStage.itemUuids.filter((uuid) => queued.has(uuid));
    if (keptUuids.length === runStage.itemUuids.length) {
      stages.push(runStage);
      continue;
    }
    changed = true;
    if (keptUuids.length > 0) {
      stages.push({ ...runStage, itemUuids: keptUuids });
    }
  }

  return changed ? { stages } : run;
};

export type WorkoutRunPosition = {
  /** 0-based position of the current stage among the stages with queued items. */
  stageIndex: number;
  stageCount: number;
  stageId: string;
  kind: WorkoutStageKind;
  /** 1-based position of the current climb in its stage. */
  positionInStage: number;
  stageSize: number;
  /** Climbs after the current one in the same stage. */
  remainingInStage: number;
};

/**
 * Where the current climb sits in the workout.
 *
 * Order comes from the queue, not from the run: climbers can reorder the queue,
 * so "3 of 5" must follow what they will actually climb next. For the same
 * reason only uuids still in the queue count, and stages with none are skipped.
 * Returns null when the current uuid is not queued or belongs to no stage.
 */
export const locateInRun = (
  run: WorkoutRun,
  currentUuid: string,
  queueUuids: readonly string[],
): WorkoutRunPosition | null => {
  const queuePositionByUuid = new Map<string, number>();
  queueUuids.forEach((uuid, position) => {
    if (!queuePositionByUuid.has(uuid)) queuePositionByUuid.set(uuid, position);
  });
  if (!queuePositionByUuid.has(currentUuid)) return null;

  const queuedStages: WorkoutRunStage[] = [];
  for (const runStage of run.stages) {
    const queuedUuids = runStage.itemUuids.filter((uuid) => queuePositionByUuid.has(uuid));
    if (queuedUuids.length === 0) continue;
    queuedUuids.sort((left, right) => (queuePositionByUuid.get(left) ?? 0) - (queuePositionByUuid.get(right) ?? 0));
    queuedStages.push({ ...runStage, itemUuids: queuedUuids });
  }

  for (let stageIndex = 0; stageIndex < queuedStages.length; stageIndex++) {
    const queuedStage = queuedStages[stageIndex];
    const positionInStage = queuedStage.itemUuids.indexOf(currentUuid);
    if (positionInStage < 0) continue;
    return {
      stageIndex,
      stageCount: queuedStages.length,
      stageId: queuedStage.id,
      kind: queuedStage.kind,
      positionInStage: positionInStage + 1,
      stageSize: queuedStage.itemUuids.length,
      remainingInStage: queuedStage.itemUuids.length - positionInStage - 1,
    };
  }
  return null;
};
