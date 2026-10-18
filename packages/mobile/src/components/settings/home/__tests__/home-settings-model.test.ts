import { describe, expect, it, vi } from 'vitest';
import { buildHomeSettingsModel, type HomeSettingsModelInput } from '../home-settings-model';
import type { MoreRow } from '../../../MoreForm.types';

const echo = (key: string) => key;

function makeInput(overrides: Partial<HomeSettingsModelInput> = {}): HomeSettingsModelInput {
  return {
    t: echo,
    startupScreen: 'climbs',
    onStartupScreenChange: vi.fn(),
    movableSections: { kind: 'hosted', content: 'movable rows', height: 340 },
    fixedRows: [{ id: 'feed', label: 'Feed', description: 'Always last', visible: true, movable: false }],
    onSectionChange: vi.fn(),
    canShowAll: true,
    onShowAll: vi.fn(),
    canApplyFocused: true,
    onApplyFocused: vi.fn(),
    canRestoreDefaults: false,
    onRestoreDefaults: vi.fn(),
    ...overrides,
  };
}

function findRow(input: HomeSettingsModelInput, key: string): MoreRow {
  const row = buildHomeSettingsModel(input)
    .sections.flatMap((section) => section.rows)
    .find((candidate) => candidate.key === key);
  if (!row) throw new Error(`no row ${key}`);
  return row;
}

describe('buildHomeSettingsModel', () => {
  it('runs the start-up tab first, then the sections, the feed, then the presets', () => {
    expect(buildHomeSettingsModel(makeInput()).sections.map((section) => section.key)).toEqual([
      'startup',
      'sections',
      'fixedSections',
      'presets',
    ]);
  });

  describe('the start-up tab', () => {
    it('offers Climbs then Home under the tab names, with Climbs chosen by default', () => {
      const row = findRow(makeInput(), 'startupScreen');
      if (row.kind !== 'segmented') throw new Error('startupScreen is not a segmented row');
      expect(row.options).toEqual([
        { key: 'climbs', label: 'mobile.nav.climbs' },
        { key: 'home', label: 'mobile.nav.home' },
      ]);
      expect(row.selectedKey).toBe('climbs');
      expect(row.label).toBe('mobile.settings.startup.title');
    });

    it('shows a stored Home choice', () => {
      const row = findRow(makeInput({ startupScreen: 'home' }), 'startupScreen');
      if (row.kind !== 'segmented') throw new Error('startupScreen is not a segmented row');
      expect(row.selectedKey).toBe('home');
    });

    it('says when it applies and what still opens elsewhere', () => {
      const section = buildHomeSettingsModel(makeInput()).sections.find((candidate) => candidate.key === 'startup');
      expect(section?.title).toBe('mobile.settings.startup.title');
      expect(section?.footer).toBe('mobile.settings.startup.footer');
    });

    it('saves known tabs only', () => {
      const onStartupScreenChange = vi.fn();
      const row = findRow(makeInput({ onStartupScreenChange }), 'startupScreen');
      if (row.kind !== 'segmented') throw new Error('startupScreen is not a segmented row');
      row.onSelect('home');
      row.onSelect('profile');
      expect(onStartupScreenChange).toHaveBeenCalledTimes(1);
      expect(onStartupScreenChange).toHaveBeenCalledWith('home');
    });
  });

  it('hosts the movable sections as one full-bleed row at their drawn height, the feed as a switch', () => {
    const onSectionChange = vi.fn();
    const model = buildHomeSettingsModel(makeInput({ onSectionChange }));
    const [, sections, fixed, presets] = model.sections;
    expect(sections.title).toBe('mobile.settings.homeSections.groupTitle');
    expect(sections.rows).toEqual([
      { kind: 'custom', key: 'movableSections', content: 'movable rows', height: 340, fullBleed: true },
    ]);
    expect(fixed.footer).toBe('mobile.settings.homeSections.settingsFooter');
    expect(fixed.rows.map((row) => row.key)).toEqual(['feed']);
    const feed = fixed.rows[0];
    if (feed.kind !== 'toggle') throw new Error('feed is not a toggle');
    expect(feed.subtitle).toBe('Always last');
    feed.onValueChange(false);
    expect(onSectionChange).toHaveBeenCalledWith('feed', false);
    expect(presets.rows.map((row) => [row.key, row.kind === 'button' ? row.disabled : null])).toEqual([
      ['showAll', false],
      ['focused', false],
      ['restoreDefaults', true],
    ]);
  });

  it('draws the movable sections as native switches in order, then a Reorder row, on the native branch', () => {
    const onSectionChange = vi.fn();
    const onReorder = vi.fn();
    const model = buildHomeSettingsModel(
      makeInput({
        onSectionChange,
        movableSections: {
          kind: 'native',
          rows: [
            { id: 'playlists', label: 'Playlists', description: 'Liked and Projects', visible: false, movable: true },
            { id: 'board', label: 'Your board', description: 'Browse or change it', visible: true, movable: true },
          ],
          onReorder,
        },
      }),
    );
    const sections = model.sections[1];
    expect(sections.rows.map((row) => [row.kind, row.key])).toEqual([
      ['toggle', 'playlists'],
      ['toggle', 'board'],
      ['nav', 'reorderSections'],
    ]);
    const [playlists, , reorder] = sections.rows;
    if (playlists.kind !== 'toggle') throw new Error('playlists is not a toggle');
    expect(playlists.value).toBe(false);
    expect(playlists.subtitle).toBe('Liked and Projects');
    playlists.onValueChange(true);
    expect(onSectionChange).toHaveBeenCalledWith('playlists', true);
    if (reorder.kind !== 'nav') throw new Error('reorderSections is not a nav row');
    expect(reorder.label).toBe('mobile.settings.homeSections.reorder');
    reorder.onPress();
    expect(onReorder).toHaveBeenCalledTimes(1);
  });
});
