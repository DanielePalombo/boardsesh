import {
  searchPhonePose,
  searchPhoneMotionPose,
  searchWordTiming,
  closerPose,
} from '../../marketing/showcase-video/anim.mjs';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SHOWCASE_TAKE_IDS } from '../lib/showcase-video/contract';
import { findShowcaseTake, takeForBoard } from '../lib/showcase-video/takes';
import {
  buildStoreSearchArgs,
  parseRenderArgs,
  parseHeadline,
  storeSearchCrewPhonePose,
  SHOWCASE_PHONE,
  screenToCanvas,
  footageAt,
} from '../lib/showcase-video/render';
import {
  creativeVideoProblems,
  storeSearchTarget,
  targetOutputs,
  targetSeconds,
  type ProbedMedia,
} from '../lib/showcase-video/targets';
import { resolveTimeline } from '../lib/showcase-video/timeline';
import {
  STORE_SEARCH_LOCALES,
  STORE_SEARCH_VARIANTS,
  storeSearchCopyPath,
  storeSearchCopyProblems,
  storeSearchPlan,
  storeSearchRecordingProblems,
  storeSearchRequiredFootageProblems,
  storeSearchTakeSegments,
  storeSearchTakeIds,
  type StoreSearchCopy,
} from '../lib/showcase-video/store-search';

const validMedia: ProbedMedia = {
  durationSeconds: 20,
  sizeBytes: 10_000_000,
  video: { codec: 'h264', profile: 'High', level: 50, width: 1920, height: 1280, fps: 30, kbps: 4000 },
  audio: null,
};

describe('Apple search video', () => {
  it('uses High level 5.0, exactly 30 fps, and no audio', () => {
    const args = buildStoreSearchArgs('input.mkv', 'output.mp4');
    expect(args[args.indexOf('-profile:v') + 1]).toBe('high');
    expect(args[args.indexOf('-level:v') + 1]).toBe('5.0');
    expect(args[args.indexOf('-r') + 1]).toBe('30');
    expect(args).toContain('-an');
    expect(creativeVideoProblems(validMedia)).toEqual([]);
    expect(creativeVideoProblems({ ...validMedia, video: { ...validMedia.video!, level: 40 } })).toContain(
      'H.264 level 4, below 5.0',
    );
    expect(creativeVideoProblems({ ...validMedia, video: { ...validMedia.video!, fps: 60 } })).toContain(
      '60 fps, not 30',
    );
    expect(
      creativeVideoProblems({ ...validMedia, audio: { codec: 'aac', channels: 2, sampleRate: 48000, kbps: 128 } }),
    ).toContain('search creative must have no audio track');
    expect(creativeVideoProblems({ ...validMedia, durationSeconds: 31 })).not.toEqual([]);
  });

  it('routes every locale and variant to its own native asset directory', () => {
    for (const locale of STORE_SEARCH_LOCALES)
      for (const variant of STORE_SEARCH_VARIANTS) {
        const target = storeSearchTarget(locale, variant);
        expect(targetSeconds(target)).toBe(variant === 'default' ? 20 : 15);
        expect(targetOutputs(target)[0]).toContain(`/app-store-creatives/${variant}/${locale}/search-results.mp4`);
        expect(target.donationLine).toBe(false);
        expect(target.audio).toEqual({ kind: 'none' });
        expect(target.storeSearch?.crossfadeFrames).toBe(15);
        expect(target.renditions[0].size).toEqual({ width: 1920, height: 1280 });
      }
    expect(parseRenderArgs(['--target', 'store-search', '--variant', 'tension', '--locale', 'all'])).toMatchObject({
      variant: 'tension',
      locales: STORE_SEARCH_LOCALES,
    });
    expect(() => parseRenderArgs(['--locale', 'it'])).toThrow(/locale/);
  });

  it('rejects stale, English, unvalidated, and wrong-board recording provenance', () => {
    const metadata = {
      takeId: 'crew',
      locale: 'fr',
      kind: 'tension',
      boardKind: 'tension',
      platform: 'ios',
      recordedAt: '2026-10-13T00:00:00Z',
      validated: true,
    };
    expect(storeSearchRecordingProblems(metadata, 'crew', 'fr', 'tension')).toEqual([]);
    expect(storeSearchRecordingProblems({ ...metadata, locale: 'en-US' }, 'crew', 'fr', 'tension')).not.toEqual([]);
    expect(storeSearchRecordingProblems({ ...metadata, kind: 'kilter' }, 'crew', 'fr', 'tension')).not.toEqual([]);
    expect(storeSearchRecordingProblems({ ...metadata, validated: false }, 'crew', 'fr', 'tension')).not.toEqual([]);
    expect(storeSearchRecordingProblems({}, 'crew', 'fr', 'tension')).toHaveLength(7);
  });

  it('keeps each friends scene on the actual recorder crew family', () => {
    for (const variant of ['default', 'kilter', 'tension'] as const) {
      const boardFamily = takeForBoard(findShowcaseTake('crew'), variant).board?.kind;
      expect(boardFamily).toBe(variant === 'default' ? 'kilter' : variant);
      const metadata = {
        takeId: 'crew',
        locale: 'de',
        kind: variant,
        boardKind: boardFamily,
        platform: 'ios',
        validated: true,
        recordedAt: '2026-10-14T00:00:00Z',
      };
      expect(storeSearchRecordingProblems(metadata, 'crew', 'de', variant)).toEqual([]);
      expect(storeSearchRecordingProblems({ ...metadata, boardKind: 'moonboard' }, 'crew', 'de', variant)).toContain(
        `native board moonboard, expected ${boardFamily}`,
      );
    }
  });

  it('requires actual MoonBoard CSV entry and loaded filters without a crew dependency', () => {
    const available = new Set<import('../lib/showcase-video/contract').ShowcaseTakeId>([
      'boards-moonboard',
      'moonboard-import',
    ]);
    expect(storeSearchRequiredFootageProblems('moonboard', available)).toEqual([
      'Missing required native take: moonboard-filter',
    ]);
    const plan = storeSearchPlan('moonboard');
    expect(plan.map((scene) => [scene.caption, scene.frames])).toEqual([
      ['moonboard', 90],
      ['moonboardCsv', 90],
      ['moonboardGrade', 120],
      ['climbHolds', 150],
    ]);
    expect(plan.flatMap((scene) => scene.takes ?? [])).toEqual([
      'boards-moonboard',
      'moonboard-import',
      'moonboard-filter',
      'boards-moonboard',
    ]);
    expect(storeSearchRequiredFootageProblems('moonboard', new Set([...available, 'moonboard-filter']))).toEqual([]);
    expect(() =>
      storeSearchTakeSegments('moonboard', 'moonboardGrade', 'moonboard-filter', 120, { frameCount: 300 }, {}),
    ).toThrow('grade-filter-shown');
  });

  it('rejects a wrong native family even when the named take and locale claim MoonBoard', () => {
    const metadata = {
      takeId: 'moonboard-filter',
      locale: 'es',
      kind: 'moonboard',
      boardKind: 'moonboard',
      platform: 'ios',
      validated: true,
      recordedAt: '2026-10-14T00:00:00Z',
    };
    expect(storeSearchRecordingProblems(metadata, 'moonboard-filter', 'es', 'moonboard')).toEqual([]);
    expect(
      storeSearchRecordingProblems({ ...metadata, boardKind: 'kilter' }, 'moonboard-filter', 'es', 'moonboard'),
    ).toContain('native board kilter, expected moonboard');
    expect(
      storeSearchRecordingProblems({ ...metadata, boardKind: undefined }, 'moonboard-filter', 'es', 'moonboard'),
    ).toContain('native board missing, expected moonboard');
    expect(
      storeSearchRecordingProblems({ ...metadata, locale: 'en-US' }, 'moonboard-filter', 'es', 'moonboard'),
    ).toContain('recording locale en-US, expected es');
    expect(
      storeSearchRecordingProblems(
        { ...metadata, takeId: 'boards-kilter', kind: 'spray', boardKind: 'kilter' },
        'boards-kilter',
        'es',
        'spray',
      ),
    ).toEqual([]);
  });

  it('keeps every approved ending native and nonempty at the exact target duration', () => {
    for (const variant of ['default', 'kilter', 'tension', 'moonboard', 'spray'] as const) {
      const timeline = resolveTimeline(new Set(SHOWCASE_TAKE_IDS), storeSearchPlan(variant));
      expect(timeline.totalFrames).toBe(variant === 'default' ? 600 : 450);
      expect(timeline.scenes.every((scene) => scene.takes.length > 0)).toBe(true);
      expect(timeline.scenes.some((scene) => scene.id === 'outro')).toBe(false);
    }
    expect(storeSearchPlan('default').map((scene) => scene.frames)).toEqual([150, 150, 150, 150]);
    expect(storeSearchPlan('spray').at(-1)).toMatchObject({ id: 'spray', caption: 'sprayNext', frames: 90 });
    expect(storeSearchPlan('tension').at(-1)).toMatchObject({
      id: 'boards',
      caption: 'climbHolds',
      frames: 90,
      takes: ['boards-tension'],
    });
  });

  it('requires fresh Tension crew and keeps its ending on the actual Tension hold map', () => {
    const plan = storeSearchPlan('tension');
    expect(plan.map((scene) => [scene.caption, scene.frames])).toEqual([
      ['tension', 105],
      ['tensionLog', 150],
      ['tensionFriends', 105],
      ['climbHolds', 90],
    ]);
    expect(storeSearchRequiredFootageProblems('tension', new Set(['boards-tension', 'log']))).toEqual([
      'Missing required native take: crew',
    ]);
    expect(storeSearchTakeIds('tension')).not.toContain('lock-screen');
    expect(plan.some((scene) => scene.caption === 'island')).toBe(false);
    const metadata = {
      takeId: 'boards-tension',
      locale: 'fr',
      kind: 'tension',
      boardKind: 'kilter',
      platform: 'ios',
      validated: true,
      recordedAt: '2026-10-14T00:00:00Z',
    };
    expect(storeSearchRecordingProblems(metadata, 'boards-tension', 'fr', 'tension')).toContain(
      'native board kilter, expected tension',
    );
    const segments = storeSearchTakeSegments('tension', 'climbHolds', 'boards-tension', 90, { frameCount: 300 }, {});
    for (const local of [0, 30, 89]) expect(footageAt(segments, local, 300)).toBe(30);
  });

  it('allows truthful native Kilter identity only for the default Live Activity ending', () => {
    const native = {
      takeId: 'lock-screen',
      locale: 'fr',
      kind: 'kilter',
      boardKind: 'kilter',
      presentation: 'live-activity-card',
      platform: 'ios',
      validated: true,
      recordedAt: '2026-10-14T00:00:00Z',
    };
    expect(storeSearchRecordingProblems(native, 'lock-screen', 'fr', 'default')).toEqual([]);
    for (const override of [
      { kind: 'default' },
      { boardKind: 'moonboard' },
      { presentation: undefined },
      { locale: 'en-US' },
      { validated: false },
    ])
      expect(storeSearchRecordingProblems({ ...native, ...override }, 'lock-screen', 'fr', 'default')).not.toEqual([]);
    expect(storeSearchRecordingProblems({ ...native, takeId: 'crew' }, 'crew', 'fr', 'default')).toContain(
      'recording variant kilter, expected default',
    );
    expect(storeSearchRequiredFootageProblems('default', new Set(['boards-kilter', 'spray', 'crew']))).toContain(
      'Missing required native take: lock-screen',
    );
  });

  it('holds the original Spray photo then reserves the real second Next for its finale', () => {
    const take = { frameCount: 404 };
    const marks = { 'next-1': 3.318, 'next-2': 6.663 };
    const opening = storeSearchTakeSegments('spray', 'spraySet', 'spray', 90, take, marks);
    const photo = storeSearchTakeSegments('spray', 'photo', 'spray', 90, take, marks);
    const ending = storeSearchTakeSegments('spray', 'sprayNext', 'spray', 90, take, marks);
    expect(photo).toEqual(opening);
    for (const local of [0, 30, 60, 89]) expect(footageAt(opening, local, take.frameCount)).toBe(30);
    expect(footageAt(ending, 0, take.frameCount)).toBe(140);
    expect(footageAt(ending, 0, take.frameCount)).toBeGreaterThan(marks['next-1'] * 30);
    expect(footageAt(ending, 0, take.frameCount)).toBeLessThan(marks['next-2'] * 30);
    expect(footageAt(ending, 89, take.frameCount)).toBeGreaterThan((marks['next-2'] + 0.8) * 30);
    const timeline = readFileSync(new URL('../../marketing/showcase-video/timeline.mjs', import.meta.url), 'utf8');
    expect(timeline).toContain('take.segmentsByCaption?.[scene.caption] ?? take.segments');
    for (const bad of [
      { 'next-1': 3.3 },
      { ...marks, 'next-2': 2 },
      { ...marks, 'next-2': NaN },
      { ...marks, 'next-2': 13 },
    ])
      expect(() => storeSearchTakeSegments('spray', 'sprayNext', 'spray', 90, take, bad)).toThrow();
  });

  it('requires a reviewed Kilter Live Activity ending instead of an empty outro', () => {
    const ending = storeSearchPlan('kilter').at(-1);
    expect(ending).toMatchObject({ id: 'lock-screen', frames: 90, optional: false });
    expect(storeSearchPlan('kilter').some((scene) => scene.id === 'outro')).toBe(false);
    const metadata = {
      takeId: 'lock-screen',
      locale: 'en-US',
      kind: 'kilter',
      platform: 'ios',
      recordedAt: '2026-10-14T00:00:00Z',
      validated: true,
      presentation: 'live-activity-card',
      boardKind: 'kilter',
    };
    expect(storeSearchRecordingProblems(metadata, 'lock-screen', 'en-US', 'kilter')).toEqual([]);
    expect(
      storeSearchRecordingProblems({ ...metadata, presentation: undefined }, 'lock-screen', 'en-US', 'kilter'),
    ).toContain('Kilter ending requires a native Live Activity card crop');
    expect(
      storeSearchRecordingProblems({ ...metadata, boardKind: 'tension' }, 'lock-screen', 'en-US', 'kilter'),
    ).toContain('Live Activity must show the actual Kilter board');
    const timeline = resolveTimeline(new Set(['boards-kilter', 'log', 'crew']), storeSearchPlan('kilter'));
    expect(timeline.skipped).not.toContain('lock-screen');
  });

  it('keeps localized captions brief and manufacturer names out of generic captions', () => {
    const expectedKeys = Object.keys(
      JSON.parse(readFileSync(storeSearchCopyPath('en-US'), 'utf8')) as StoreSearchCopy,
    ).sort();
    for (const locale of STORE_SEARCH_LOCALES) {
      const copy = JSON.parse(readFileSync(storeSearchCopyPath(locale), 'utf8')) as StoreSearchCopy;
      expect(Object.keys(copy).sort()).toEqual(expectedKeys);
      for (const removed of ['outro', 'moonboardLog', 'grade']) expect(copy).not.toHaveProperty(removed);
      expect(storeSearchCopyProblems(copy), locale).toEqual([]);
      const islandWords = parseHeadline(copy.island).flat();
      expect(
        islandWords.some((word) => word.accent),
        `${locale}: Live Activity accent`,
      ).toBe(true);
      expect(
        islandWords.every((word) => !word.text.includes('*')),
        `${locale}: no literal formatting`,
      ).toBe(true);
      for (const caption of Object.values(copy)) {
        const parsed = parseHeadline(caption);
        expect(JSON.stringify(parsed), `${locale}: literal accent markup`).not.toContain('*');
      }
      for (const variant of STORE_SEARCH_VARIANTS) {
        for (const scene of storeSearchPlan(variant))
          expect(copy[scene.caption!], `${locale}/${scene.caption}`).toBeTruthy();
        const timeline = resolveTimeline(new Set(SHOWCASE_TAKE_IDS), storeSearchPlan(variant));
        expect(timeline.scenes.every((scene) => scene.background === 'dark' && scene.callouts.length === 0)).toBe(true);
      }
      expect(copy.boards).not.toMatch(/Kilter|Tension|MoonBoard/);
    }
  });
});

describe('store search crew framing', () => {
  const canvas = { width: 1920, height: 1280 };
  const safeArea = { top: 120, bottom: 120, left: 120, right: 120 };

  it('fits the complete phone beside the caption without cropping the bottom queue rows', () => {
    const pose = storeSearchCrewPhonePose(SHOWCASE_PHONE, canvas, safeArea);
    const halfWidth = (SHOWCASE_PHONE.width * pose.scale) / 2;
    const halfHeight = (SHOWCASE_PHONE.height * pose.scale) / 2;
    expect(pose.cy - halfHeight).toBeGreaterThanOrEqual(safeArea.top);
    expect(pose.cy + halfHeight).toBeLessThanOrEqual(canvas.height - safeArea.bottom);
    expect(pose.cx - halfWidth).toBeGreaterThan(120 + 740);
    expect(pose.cx + halfWidth).toBeLessThanOrEqual(canvas.width - safeArea.right);
    expect(pose.scale).toBeGreaterThan(1);
    expect(pose.scale).toBeLessThan(1.6);
    expect([pose.rx, pose.ry, pose.rz]).toEqual([0, 0, 0]);
  });

  it('keeps even the bottom-most native avatar and menu pixels inside the stage safe area', () => {
    const pose = storeSearchCrewPhonePose(SHOWCASE_PHONE, canvas, safeArea);
    const screen = { width: 440, height: 956 };
    // Stronger than any particular row position: every native pixel, including
    // a peer avatar at the bottom edge of a dynamic queue sheet, remains visible.
    const bottomAvatar = screenToCanvas({ x: 360, y: 936, width: 20, height: 20 }, screen, pose, canvas);
    const bottomMenu = screenToCanvas({ x: 0, y: 910, width: 440, height: 46 }, screen, pose, canvas);
    for (const rect of [bottomAvatar, bottomMenu]) {
      expect(rect.y).toBeGreaterThanOrEqual(safeArea.top);
      expect(rect.y + rect.height).toBeLessThanOrEqual(canvas.height - safeArea.bottom);
      expect(rect.x).toBeGreaterThan(120 + 740);
      expect(rect.x + rect.width).toBeLessThanOrEqual(canvas.width - safeArea.right);
    }
  });

  it('fits every crew caption while keeping non-crew framing and loop painting unchanged', () => {
    const timeline = readFileSync(new URL('../../marketing/showcase-video/timeline.mjs', import.meta.url), 'utf8');
    const defaultPose = { cx: 1420, cy: 910, scale: 1.6, rx: 0, ry: 0, rz: 0 };
    const crewPose = storeSearchCrewPhonePose(SHOWCASE_PHONE, canvas, safeArea);
    const fittedCaptions = new Set<string>();
    for (const variant of STORE_SEARCH_VARIANTS) {
      const scenes = resolveTimeline(new Set(SHOWCASE_TAKE_IDS), storeSearchPlan(variant)).scenes;
      for (const scene of scenes) {
        const renderedPose = searchPhonePose(scene.takes[0], scene.takes.length, defaultPose, crewPose);
        if (scene.takes.length === 1 && scene.takes[0] === 'crew') {
          fittedCaptions.add(scene.caption ?? '');
          expect(renderedPose).toBe(crewPose);
        } else {
          expect(renderedPose).toBe(defaultPose);
        }
      }
    }
    expect([...fittedCaptions].sort()).toEqual(['crew', 'friends', 'tensionFriends']);
    expect(searchPhonePose('boards-kilter', 1, defaultPose, crewPose)).toBe(defaultPose);
    expect(searchPhonePose('crew', 2, defaultPose, crewPose)).toBe(defaultPose);
    expect(searchPhonePose('crew', 1, defaultPose, undefined)).toBe(defaultPose);
    expect(timeline).toContain('searchPhonePose(');
    expect(timeline).toContain('paintSearchScene(opening, 0, frame)');
    expect(timeline).toContain("cy: single ? (scene.id === 'lock-screen' ? 925 : 910) : 820");
    expect(timeline).toContain('scale: single ? 1.6 : index === Math.floor(count / 2) ? 1.12 : 0.92');
  });
});

describe('hero motion for store search', () => {
  const slot = { cx: 1420, cy: 640, scale: 1.15, rx: 0, ry: 0, rz: 0 };

  it('leads the beat with a spring then keeps the real peer row settled until the exit', () => {
    const off = searchPhoneMotionPose(slot, -12, 90);
    const arriving = searchPhoneMotionPose(slot, -6, 90);
    expect(off.cx).toBeGreaterThan(1920);
    expect(arriving.cx).not.toBe(off.cx);
    for (const frame of [0, 1, 12, 40, 77]) expect(searchPhoneMotionPose(slot, frame, 90)).toEqual(slot);
    expect(searchPhoneMotionPose(slot, 83, 90).cx).toBeGreaterThan(slot.cx);
    expect(searchPhoneMotionPose(slot, 89, 90).cx).toBeGreaterThan(1920);
    // No clamped spring residual jumps at the entrance endpoint.
    expect(Math.abs(searchPhoneMotionPose(slot, -0.00001, 90).cx - slot.cx)).toBeLessThan(0.001);
  });

  it('keeps the opening readable and stationary instead of replaying an entrance after frame zero', () => {
    for (const frame of [0, 1, 10, 40, 77]) {
      expect(searchPhoneMotionPose(slot, frame, 90, { opening: true })).toEqual(slot);
    }
    expect(searchPhoneMotionPose(slot, 83, 90, { opening: true })).not.toEqual(slot);
  });

  it('staggers board phones in two dimensions and never adds a tilt', () => {
    const first = searchPhoneMotionPose(slot, -10, 90, { index: 0, count: 3 });
    const middle = searchPhoneMotionPose(slot, -10, 90, { index: 1, count: 3 });
    const last = searchPhoneMotionPose(slot, -10, 90, { index: 2, count: 3 });
    expect(first.cy).not.toBe(middle.cy);
    expect(last.cx).toBeGreaterThan(1920);
    for (let index = 0; index < 3; index++) {
      for (const frame of [-12, -6, 0, 10, 78, 89]) {
        const pose = searchPhoneMotionPose(slot, frame, 90, { index, count: 3 });
        expect([pose.rx, pose.ry, pose.rz]).toEqual([0, 0, 0]);
        if (frame === 0) expect(pose).toEqual(slot);
      }
    }
  });

  it('makes every locale caption fully readable by frame ten, including the accent', () => {
    for (const locale of STORE_SEARCH_LOCALES) {
      const copy = JSON.parse(readFileSync(storeSearchCopyPath(locale), 'utf8')) as StoreSearchCopy;
      for (const caption of Object.values(copy)) {
        const regularCount = parseHeadline(caption)
          .flat()
          .filter((word) => !word.accent).length;
        for (const deadline of [10, 7]) {
          const timing = searchWordTiming(regularCount, deadline);
          const lastRegular = timing.firstWord + timing.wordStagger * Math.max(0, regularCount - 1);
          expect(lastRegular + timing.wordFrames).toBeLessThanOrEqual(deadline);
          expect(lastRegular + timing.accentDelay + timing.accentFrames).toBeLessThanOrEqual(deadline);
        }
      }
    }
    const css = readFileSync(new URL('../../marketing/showcase-video/scenes.css', import.meta.url), 'utf8');
    expect(css).not.toMatch(/\.search-caption \.w\s*\{/);
  });

  it('lands the hero loop rise exactly on the original phone without an empty last frame', () => {
    expect(closerPose(slot, 435, 435, 449, 1280)).not.toEqual(slot);
    expect(closerPose(slot, 449, 435, 449, 1280)).toEqual(slot);
  });
});
