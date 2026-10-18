import { useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { MoreForm } from '../../MoreForm';
import { hapticSelection } from '../../../lib/haptics';
import type { HomeSectionId } from '../../../lib/home-sections';
import { useHomeSectionControls } from '../../home/use-home-section-controls';
import { buildHomeSettingsModel } from './home-settings-model';

/**
 * Settings › Home. The switches, presets and the reporting behind them are the
 * Customize Home sheet's own (`useHomeSectionControls`), so the two never
 * disagree; every change reports `Setting Changed` under the `homeScreen` page.
 */
export function HomeSettingsScreen() {
  const { t } = useTranslation('common');
  const {
    rows,
    onVisibleChange,
    showAll,
    applyFocused,
    restoreDefaults,
    canShowAll,
    canApplyFocused,
    canRestoreDefaults,
  } = useHomeSectionControls();
  // The native form's switch has no buzz of its own, unlike the sheet's.
  const onSectionChange = useCallback(
    (sectionId: HomeSectionId, visible: boolean) => {
      hapticSelection();
      onVisibleChange(sectionId, visible);
    },
    [onVisibleChange],
  );
  const model = useMemo(
    () =>
      buildHomeSettingsModel({
        t,
        rows,
        onSectionChange,
        canShowAll,
        onShowAll: showAll,
        canApplyFocused,
        onApplyFocused: applyFocused,
        canRestoreDefaults,
        onRestoreDefaults: restoreDefaults,
      }),
    [t, rows, onSectionChange, canShowAll, showAll, canApplyFocused, applyFocused, canRestoreDefaults, restoreDefaults],
  );
  return <MoreForm model={model} />;
}
