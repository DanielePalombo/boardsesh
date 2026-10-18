import type { HomeSectionId } from '../../../lib/home-sections';
import type { StartupScreen } from '../../../settings';
import type { MoreFormModel, MoreOption } from '../../MoreForm.types';
import type { SectionLayoutRowModel } from '../../section-layout/SectionLayoutList';
import type { SettingsTranslate } from '../root/settings-pages';

export type HomeSettingsModelInput = {
  t: SettingsTranslate;
  /** The tab an ordinary launch opens on (#6536). */
  startupScreen: StartupScreen;
  onStartupScreenChange: (screen: StartupScreen) => void;
  /** Home's sections in the climber's order, from `useHomeSectionControls`. */
  rows: readonly SectionLayoutRowModel<HomeSectionId>[];
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
 * the app opens on Climbs or Home, then a switch per section in the saved order,
 * then Show all, Focused and Restore defaults. No arrows: the order changes in
 * the Customize Home sheet on Home itself.
 */
export function buildHomeSettingsModel(input: HomeSettingsModelInput): MoreFormModel {
  const { t } = input;
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
        footer: t('mobile.settings.homeSections.settingsFooter'),
        rows: input.rows.map((row) => ({
          kind: 'toggle',
          key: row.id,
          label: row.label,
          subtitle: row.description,
          value: row.visible,
          onValueChange: (visible: boolean) => input.onSectionChange(row.id, visible),
        })),
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
