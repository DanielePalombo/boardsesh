import { useCallback, useMemo, useState } from 'react';
import { Platform, useWindowDimensions } from 'react-native';
import { useTranslation } from 'react-i18next';
import { MoreForm } from '../../MoreForm';
import {
  announceSectionMoved,
  placeSectionLayoutRows,
  type PlacedSectionLayoutRow,
} from '../../section-layout/SectionLayoutList';
import type { SectionMoveDirection } from '../../../lib/section-layout';
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
 * switches and ↑/↓ arrows (native form buttons on Android), then the presets. The rows and actions are the
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
  // on a Pixel 8 Pro, #6546), so there each section is a native switch with
  // native move buttons on the same page.
  const nativeSectionRows = Platform.OS === 'android';
  // The same buzz and spoken landing place as the sheet's arrows.
  const onNativeMove = useCallback(
    (row: PlacedSectionLayoutRow<HomeSectionId>, direction: SectionMoveDirection) => {
      if (!onMove(row.id, direction)) return;
      hapticSelection();
      announceSectionMoved(t, row, direction);
    },
    [onMove, t],
  );
  const movableSections = useMemo(
    () =>
      nativeSectionRows
        ? { kind: 'native' as const, rows: placeSectionLayoutRows(movableRows), onMove: onNativeMove }
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
    [nativeSectionRows, movableRows, onNativeMove, onVisibleChange, onMove, listHeight],
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
  return <MoreForm model={model} />;
}
