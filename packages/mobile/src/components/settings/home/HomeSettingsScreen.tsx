import { useCallback, useMemo, useState } from 'react';
import { Platform, useWindowDimensions } from 'react-native';
import { useTranslation } from 'react-i18next';
import { MoreForm } from '../../MoreForm';
import { HomeCustomizeSheet } from '../../home/HomeCustomizeSheet';
import { useMountedOnFirstOpen } from '../../../hooks/use-mounted-on-first-open';
import { normaliseStartupScreen } from '../../../lib/app-entry-route';
import { hapticSelection } from '../../../lib/haptics';
import type { HomeSectionId } from '../../../lib/home-sections';
import { trackSettingChanged } from '../../../lib/settings-analytics';
import { useSetting, type StartupScreen } from '../../../settings';
import { useHomeSectionControls } from '../../home/use-home-section-controls';
import { buildHomeSettingsModel } from './home-settings-model';
import { HomeSectionsFormList } from './HomeSectionsFormList';

// A first guess at one row's height at the default text size, until the list
// reports what it really drew. Scaled by the text size so the guess is close.
const ROW_HEIGHT_GUESS = 68;

/**
 * Settings › Home. "Open the app on" first, then the sections with their
 * switches and ↑/↓ arrows (on Android, switches and a Reorder row that opens
 * Customize Home), then the presets. The rows and actions are the
 * Customize Home sheet's own (`useHomeSectionControls`) over the same store, so
 * the page, the sheet and Home always agree. Every change reports one
 * `Setting Changed` under the `homeScreen` page.
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
    onMove,
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
  const movableRows = useMemo(() => rows.filter((row) => row.movable), [rows]);
  const fixedRows = useMemo(() => rows.filter((row) => !row.movable), [rows]);
  const { fontScale } = useWindowDimensions();
  const [measuredListHeight, setMeasuredListHeight] = useState<number | null>(null);
  const listHeight = measuredListHeight ?? Math.ceil(movableRows.length * ROW_HEIGHT_GUESS * Math.max(fontScale, 1));
  // Android's Compose form draws no hosted React Native row on a real phone (QA
  // on a Pixel 8 Pro, #6546), so there the sections are native switches and the
  // Customize Home sheet does the reordering.
  const nativeSectionRows = Platform.OS === 'android';
  const [reorderOpen, setReorderOpen] = useState(false);
  const mountReorderSheet = useMountedOnFirstOpen(reorderOpen);
  const openReorder = useCallback(() => setReorderOpen(true), []);
  const closeReorder = useCallback(() => setReorderOpen(false), []);
  const movableSections = useMemo(
    () =>
      nativeSectionRows
        ? { kind: 'native' as const, rows: movableRows, onReorder: openReorder }
        : {
            kind: 'hosted' as const,
            content: (
              <HomeSectionsFormList
                rows={movableRows}
                onVisibleChange={onVisibleChange}
                onMove={onMove}
                onHeightChange={setMeasuredListHeight}
              />
            ),
            height: listHeight,
          },
    [nativeSectionRows, movableRows, openReorder, onVisibleChange, onMove, listHeight],
  );
  const model = useMemo(
    () =>
      buildHomeSettingsModel({
        t,
        startupScreen,
        onStartupScreenChange,
        movableSections,
        fixedRows,
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
      movableSections,
      fixedRows,
      onSectionChange,
      canShowAll,
      showAll,
      canApplyFocused,
      applyFocused,
      canRestoreDefaults,
      restoreDefaults,
    ],
  );
  return (
    <>
      <MoreForm model={model} />
      {mountReorderSheet ? <HomeCustomizeSheet visible={reorderOpen} onClose={closeReorder} /> : null}
    </>
  );
}
