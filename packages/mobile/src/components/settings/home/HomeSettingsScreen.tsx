import { useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { MoreForm } from '../../MoreForm';
import { normaliseStartupScreen } from '../../../lib/app-entry-route';
import { hapticSelection } from '../../../lib/haptics';
import type { HomeSectionId } from '../../../lib/home-sections';
import { trackSettingChanged } from '../../../lib/settings-analytics';
import { useSetting, type StartupScreen } from '../../../settings';
import { useHomeSectionControls } from '../../home/use-home-section-controls';
import { buildHomeSettingsModel } from './home-settings-model';

/**
 * Settings › Home. "Open the app on" first, then the switches and presets, which
 * are the Customize Home sheet's own (`useHomeSectionControls`), so the two never
 * disagree. Every change reports one `Setting Changed` under the `homeScreen` page.
 */
export function HomeSettingsScreen() {
  const { t } = useTranslation('common');
  // Read by `getAppEntryTab()` on the next start; writing it moves nothing now.
  // Normalised the same way, so an unknown stored value shows Climbs chosen.
  const [storedStartupScreen, setStartupScreen] = useSetting('startupScreen');
  const startupScreen = normaliseStartupScreen(storedStartupScreen);
  const onStartupScreenChange = useCallback(
    (screen: StartupScreen) => {
      if (screen === startupScreen) return;
      hapticSelection();
      trackSettingChanged('homeScreen', 'startupScreen', screen);
      setStartupScreen(screen);
    },
    [startupScreen, setStartupScreen],
  );
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
        startupScreen,
        onStartupScreenChange,
        rows,
        onSectionChange,
        canShowAll,
        onShowAll: showAll,
        canApplyFocused,
        onApplyFocused: applyFocused,
        canRestoreDefaults,
        onRestoreDefaults: restoreDefaults,
      }),
    [
      t,
      startupScreen,
      onStartupScreenChange,
      rows,
      onSectionChange,
      canShowAll,
      showAll,
      canApplyFocused,
      applyFocused,
      canRestoreDefaults,
      restoreDefaults,
    ],
  );
  return <MoreForm model={model} />;
}
