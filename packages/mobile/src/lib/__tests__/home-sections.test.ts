import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SettingsChange } from '../../settings/hooks';
import { canMoveSection, sanitiseSectionLayout, withSectionMoved } from '../section-layout';

const settings = vi.hoisted(() => ({
  listeners: new Set<(change: SettingsChange) => void>(),
  values: new Map<string, unknown>(),
  writes: [] as unknown[],
}));
vi.mock('../../settings/hooks', () => ({
  subscribeSettings: (listener: (change: SettingsChange) => void) => {
    settings.listeners.add(listener);
    return () => settings.listeners.delete(listener);
  },
  getSetting: (key: string) => settings.values.get(key) ?? null,
  setSetting: (key: string, value: unknown) => {
    settings.writes.push(value);
    settings.values.set(key, value);
    for (const listener of settings.listeners) listener({ kind: 'setting', key: key as never });
  },
}));

async function loadHomeSections() {
  vi.resetModules();
  return import('../home-sections');
}

beforeEach(() => {
  settings.listeners.clear();
  settings.values.clear();
  settings.writes = [];
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('Home sections', () => {
  it("defaults to today's Home: Climbing now, then the feed, with the new cards hidden", async () => {
    const { HOME_SECTIONS, homeSectionsStore, visibleTopHomeSections } = await loadHomeSections();
    expect(HOME_SECTIONS.defaults.order).toEqual(['board', 'session', 'playlists', 'climbingNow', 'feed']);
    expect(HOME_SECTIONS.defaults.visible).toEqual({
      board: false,
      session: false,
      playlists: false,
      climbingNow: true,
      feed: true,
    });
    expect(homeSectionsStore.getLayout()).toEqual(HOME_SECTIONS.defaults);
    expect(visibleTopHomeSections(homeSectionsStore.getLayout())).toEqual(['climbingNow']);
  });

  it('keeps the feed last: it never moves, and nothing moves below it', async () => {
    const { HOME_SECTIONS } = await loadHomeSections();
    const layout = HOME_SECTIONS.defaults;
    expect(canMoveSection(HOME_SECTIONS, layout, 'feed', -1)).toBe(false);
    expect(canMoveSection(HOME_SECTIONS, layout, 'climbingNow', 1)).toBe(false);
    expect(withSectionMoved(HOME_SECTIONS, layout, 'climbingNow', 1)).toBe(layout);
    // A stored order with the feed in the middle still reads it last.
    expect(sanitiseSectionLayout(HOME_SECTIONS, { order: ['feed', 'board'], visible: {} }).order).toEqual([
      'board',
      'session',
      'playlists',
      'climbingNow',
      'feed',
    ]);
  });

  it('Focused shows the three cards, hides the feed and Climbing now, and keeps the order', async () => {
    const { HOME_SECTIONS, focusedHomeLayout, isFocusedHomeLayout, visibleTopHomeSections } = await loadHomeSections();
    const reordered = withSectionMoved(HOME_SECTIONS, HOME_SECTIONS.defaults, 'playlists', -1);
    const focused = focusedHomeLayout(reordered);
    expect(focused.order).toEqual(['board', 'playlists', 'session', 'climbingNow', 'feed']);
    expect(visibleTopHomeSections(focused)).toEqual(['board', 'playlists', 'session']);
    expect(focused.visible.feed).toBe(false);
    expect(isFocusedHomeLayout(focused)).toBe(true);
    expect(isFocusedHomeLayout(HOME_SECTIONS.defaults)).toBe(false);
  });

  it('stores edits under homeSectionsV1, and Restore defaults stores nothing', async () => {
    const { homeSectionsStore, isDefaultHomeLayout, focusedHomeLayout } = await loadHomeSections();
    homeSectionsStore.apply(focusedHomeLayout(homeSectionsStore.getLayout()));
    expect(settings.values.get('homeSectionsV1')).toEqual({
      version: 1,
      order: ['board', 'session', 'playlists', 'climbingNow', 'feed'],
      visible: { board: true, session: true, playlists: true, climbingNow: false, feed: false },
    });
    homeSectionsStore.restoreDefaults();
    expect(settings.values.get('homeSectionsV1')).toBeNull();
    expect(isDefaultHomeLayout(homeSectionsStore.getLayout())).toBe(true);
  });

  it('reads a stored layout at launch, before the first frame', async () => {
    settings.values.set('homeSectionsV1', {
      version: 1,
      order: ['session', 'board', 'playlists', 'climbingNow', 'feed'],
      visible: { session: true, board: true, climbingNow: false },
    });
    const { homeSectionsStore, visibleTopHomeSections } = await loadHomeSections();
    expect(visibleTopHomeSections(homeSectionsStore.getLayout())).toEqual(['session', 'board']);
    expect(homeSectionsStore.getLayout().visible.feed).toBe(true);
  });

  it('starts screenshot builds on the default Home and never saves their edits', async () => {
    vi.stubEnv('EXPO_PUBLIC_SCREENSHOT_MODE', '1');
    settings.values.set('homeSectionsV1', {
      version: 1,
      order: ['board', 'session', 'playlists', 'climbingNow', 'feed'],
      visible: { board: true, feed: false },
    });
    const { HOME_SECTIONS, homeSectionsStore, focusedHomeLayout, isFocusedHomeLayout } = await loadHomeSections();
    expect(homeSectionsStore.getLayout()).toEqual(HOME_SECTIONS.defaults);
    homeSectionsStore.apply(focusedHomeLayout(homeSectionsStore.getLayout()));
    // The edit shows for this launch, so a capture can show it, but nothing is written.
    expect(isFocusedHomeLayout(homeSectionsStore.getLayout())).toBe(true);
    expect(settings.writes).toEqual([]);
  });
});
