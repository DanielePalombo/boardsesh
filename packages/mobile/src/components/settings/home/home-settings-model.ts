import type { HomeSectionId } from '../../../lib/home-sections';
import type { MoreFormModel } from '../../MoreForm.types';
import type { SectionLayoutRowModel } from '../../section-layout/SectionLayoutList';
import type { SettingsTranslate } from '../root/settings-pages';

export type HomeSettingsModelInput = {
  t: SettingsTranslate;
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
 * Settings › Home, on the native form like Board and Climbs & grades: a switch
 * per section in the saved order, then Show all, Focused and Restore defaults.
 * No arrows: the order changes in the Customize Home sheet on Home itself.
 */
export function buildHomeSettingsModel(input: HomeSettingsModelInput): MoreFormModel {
  const { t } = input;
  return {
    sections: [
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
