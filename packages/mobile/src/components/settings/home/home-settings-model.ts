import type { ReactNode } from 'react';
import type { HomeSectionId } from '../../../lib/home-sections';
import type { StartupScreen } from '../../../settings';
import type { MoreFormModel, MoreOption, MoreRow } from '../../MoreForm.types';
import type { SectionLayoutRowModel } from '../../section-layout/SectionLayoutList';
import type { SettingsTranslate } from '../root/settings-pages';

export type HomeSettingsModelInput = {
  t: SettingsTranslate;
  /** The tab an ordinary launch opens on (#6536). */
  startupScreen: StartupScreen;
  onStartupScreenChange: (screen: StartupScreen) => void;
  /**
   * How the sections that move draw. The form has no reorderable row of its own.
   * - `hosted` (iOS, browser): one React Native row, `HomeSectionsFormList`, the
   *   sheet's switch-and-arrows rows.
   * - `native` (Android): a native switch per section in the saved order, then a
   *   row that opens Customize Home to reorder. The Compose form draws no hosted
   *   React Native row on a real phone (QA on a Pixel 8 Pro, #6546).
   */
  movableSections:
    | { kind: 'hosted'; content: ReactNode; height: number }
    | { kind: 'native'; rows: readonly SectionLayoutRowModel<HomeSectionId>[]; onReorder: () => void };
  /** The sections that keep their place (the feed, always last), as native switches. */
  fixedRows: readonly SectionLayoutRowModel<HomeSectionId>[];
  onSectionChange: (sectionId: HomeSectionId, visible: boolean) => void;
  canShowAll: boolean;
  onShowAll: () => void;
  canApplyFocused: boolean;
  onApplyFocused: () => void;
  canRestoreDefaults: boolean;
  onRestoreDefaults: () => void;
};

/**
 * Settings › Home, on the native form like Board and Climbs & grades: whether
 * the app opens on Climbs or Home; the sections with their switches and ↑/↓
 * arrows (the one React Native row, #6480's exception, at Marco's ask; on
 * Android native switches and a Reorder row instead); the feed, which stays
 * last; then Show all, Focused and Restore defaults.
 */
export function buildHomeSettingsModel(input: HomeSettingsModelInput): MoreFormModel {
  const { t, movableSections } = input;
  const sectionToggle = (row: SectionLayoutRowModel<HomeSectionId>): MoreRow => ({
    kind: 'toggle',
    key: row.id,
    label: row.label,
    subtitle: row.description,
    value: row.visible,
    onValueChange: (visible: boolean) => input.onSectionChange(row.id, visible),
  });
  const movableRows: MoreRow[] =
    movableSections.kind === 'hosted'
      ? [
          {
            kind: 'custom',
            key: 'movableSections',
            content: movableSections.content,
            height: movableSections.height,
            fullBleed: true,
          },
        ]
      : [
          ...movableSections.rows.map(sectionToggle),
          {
            kind: 'nav',
            key: 'reorderSections',
            label: t('mobile.settings.homeSections.reorder'),
            onPress: movableSections.onReorder,
          },
        ];
  // The tab names, so the choice reads exactly like the tab bar. Climbs first:
  // it is the default.
  const startupOptions: (MoreOption & { key: StartupScreen })[] = [
    { key: 'climbs', label: t('mobile.nav.climbs') },
    { key: 'home', label: t('mobile.nav.home') },
  ];
  return {
    sections: [
      {
        // Changing it never navigates: the footer says when it takes effect,
        // and what still opens somewhere else.
        key: 'startup',
        title: t('mobile.settings.startup.title'),
        footer: t('mobile.settings.startup.footer'),
        rows: [
          {
            kind: 'segmented',
            key: 'startupScreen',
            label: t('mobile.settings.startup.title'),
            options: startupOptions,
            selectedKey: input.startupScreen,
            onSelect: (key) => {
              const next = startupOptions.find((option) => option.key === key);
              if (next) input.onStartupScreenChange(next.key);
            },
          },
        ],
      },
      {
        key: 'sections',
        title: t('mobile.settings.homeSections.groupTitle'),
        rows: movableRows,
      },
      {
        key: 'fixedSections',
        footer: t('mobile.settings.homeSections.settingsFooter'),
        rows: input.fixedRows.map(sectionToggle),
      },
      {
        key: 'presets',
        footer: t('mobile.settings.homeSections.footer'),
        rows: [
          {
            kind: 'button',
            key: 'showAll',
            label: t('mobile.settings.homeSections.showAll'),
            disabled: !input.canShowAll,
            onPress: input.onShowAll,
          },
          {
            kind: 'button',
            key: 'focused',
            label: t('mobile.settings.homeSections.focused'),
            disabled: !input.canApplyFocused,
            onPress: input.onApplyFocused,
          },
          {
            kind: 'button',
            key: 'restoreDefaults',
            label: t('mobile.settings.homeSections.restoreDefaults'),
            disabled: !input.canRestoreDefaults,
            onPress: input.onRestoreDefaults,
          },
        ],
      },
    ],
  };
}
