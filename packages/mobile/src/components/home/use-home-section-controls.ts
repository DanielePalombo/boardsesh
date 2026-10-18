import { useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  HOME_SECTIONS,
  focusedHomeLayout,
  homeSectionsStore,
  isDefaultHomeLayout,
  isFocusedHomeLayout,
  useHomeSectionLayout,
  type HomeSectionId,
} from '../../lib/home-sections';
import type { SectionMoveDirection } from '../../lib/section-layout';
import { hapticSelection } from '../../lib/haptics';
import { trackSettingChanged } from '../../lib/settings-analytics';
import type { MoreSection } from '../MoreForm.types';
import type { SectionLayoutRowModel } from '../section-layout/SectionLayoutList';

// Every Home edit reports `Setting Changed` under this page, from the Customize
// sheet and from Settings › General alike. Values are section ids or preset
// names, never labels.
const ANALYTICS_PAGE = 'homeScreen';

/** Settings › General's row keys. Kept apart from the page's own keys, and skipped by its tracking wrapper. */
export const HOME_SECTION_SETTINGS_ROW_PREFIX = 'homeSection.';

/** Labels, rows and actions shared by the Customize Home sheet and Settings › General. */
export function useHomeSectionControls() {
  const { t } = useTranslation('common');
  const layout = useHomeSectionLayout();
  const customizeLabel = t('mobile.settings.homeSections.customize');
  const groupTitle = t('mobile.settings.homeSections.title');
  const description = t('mobile.settings.homeSections.description');
  const settingsFooter = t('mobile.settings.homeSections.settingsFooter');
  const footer = t('mobile.settings.homeSections.footer');
  const showAllLabel = t('mobile.settings.homeSections.showAll');
  const focusedLabel = t('mobile.settings.homeSections.focused');
  const restoreDefaultsLabel = t('mobile.settings.homeSections.restoreDefaults');
  const boardLabel = t('mobile.settings.homeSections.sections.board');
  const sessionLabel = t('mobile.settings.homeSections.sections.session');
  const playlistsLabel = t('mobile.settings.homeSections.sections.playlists');
  const climbingNowLabel = t('mobile.settings.homeSections.sections.climbingNow');
  const feedLabel = t('mobile.settings.homeSections.sections.feed');
  const boardDescription = t('mobile.settings.homeSections.descriptions.board');
  const sessionDescription = t('mobile.settings.homeSections.descriptions.session');
  const playlistsDescription = t('mobile.settings.homeSections.descriptions.playlists');
  const climbingNowDescription = t('mobile.settings.homeSections.descriptions.climbingNow');
  const feedDescription = t('mobile.settings.homeSections.descriptions.feed');

  const rows = useMemo<SectionLayoutRowModel<HomeSectionId>[]>(() => {
    const labels: Record<HomeSectionId, string> = {
      board: boardLabel,
      session: sessionLabel,
      playlists: playlistsLabel,
      climbingNow: climbingNowLabel,
      feed: feedLabel,
    };
    const descriptions: Record<HomeSectionId, string> = {
      board: boardDescription,
      session: sessionDescription,
      playlists: playlistsDescription,
      climbingNow: climbingNowDescription,
      feed: feedDescription,
    };
    // The feed keeps its place at the bottom: a switch and no arrows, in its own group.
    return layout.order.map((id) => ({
      id,
      label: labels[id],
      description: descriptions[id],
      visible: layout.visible[id],
      movable: id !== HOME_SECTIONS.lockedLast,
    }));
  }, [
    layout,
    boardLabel,
    sessionLabel,
    playlistsLabel,
    climbingNowLabel,
    feedLabel,
    boardDescription,
    sessionDescription,
    playlistsDescription,
    climbingNowDescription,
    feedDescription,
  ]);

  const onVisibleChange = useCallback((sectionId: HomeSectionId, visible: boolean) => {
    trackSettingChanged(ANALYTICS_PAGE, sectionId, visible);
    homeSectionsStore.setVisible(sectionId, visible);
  }, []);
  const onMove = useCallback((sectionId: HomeSectionId, direction: SectionMoveDirection) => {
    trackSettingChanged(ANALYTICS_PAGE, direction === -1 ? 'moveUp' : 'moveDown', sectionId);
    homeSectionsStore.move(sectionId, direction);
  }, []);

  const canShowAll = rows.some((row) => !row.visible);
  const canApplyFocused = !isFocusedHomeLayout(layout);
  const canRestoreDefaults = !isDefaultHomeLayout(layout);
  const showAll = useCallback(() => {
    if (!canShowAll) return;
    hapticSelection();
    trackSettingChanged(ANALYTICS_PAGE, 'preset', 'showAll');
    homeSectionsStore.setAllVisible(true);
  }, [canShowAll]);
  const applyFocused = useCallback(() => {
    if (!canApplyFocused) return;
    hapticSelection();
    trackSettingChanged(ANALYTICS_PAGE, 'preset', 'focused');
    homeSectionsStore.apply(focusedHomeLayout(homeSectionsStore.getLayout()));
  }, [canApplyFocused]);
  const restoreDefaults = useCallback(() => {
    if (!canRestoreDefaults) return;
    hapticSelection();
    trackSettingChanged(ANALYTICS_PAGE, 'preset', 'default');
    homeSectionsStore.restoreDefaults();
  }, [canRestoreDefaults]);

  // Settings stays on the native form (#6477): switches in the saved order and
  // the presets, no arrows. The order changes in the Customize Home sheet.
  const settingsSection = useMemo<MoreSection>(
    () => ({
      key: 'homeSections',
      title: groupTitle,
      footer: settingsFooter,
      rows: [
        ...rows.map((row) => ({
          kind: 'toggle' as const,
          key: `${HOME_SECTION_SETTINGS_ROW_PREFIX}${row.id}`,
          label: row.label,
          subtitle: row.description,
          value: row.visible,
          onValueChange: (enabled: boolean) => {
            hapticSelection();
            onVisibleChange(row.id, enabled);
          },
        })),
        { kind: 'button', key: 'homeSectionsShowAll', label: showAllLabel, disabled: !canShowAll, onPress: showAll },
        {
          kind: 'button',
          key: 'homeSectionsFocused',
          label: focusedLabel,
          disabled: !canApplyFocused,
          onPress: applyFocused,
        },
        {
          kind: 'button',
          key: 'homeSectionsRestoreDefaults',
          label: restoreDefaultsLabel,
          disabled: !canRestoreDefaults,
          onPress: restoreDefaults,
        },
      ],
    }),
    [
      groupTitle,
      settingsFooter,
      rows,
      onVisibleChange,
      showAllLabel,
      canShowAll,
      showAll,
      focusedLabel,
      canApplyFocused,
      applyFocused,
      restoreDefaultsLabel,
      canRestoreDefaults,
      restoreDefaults,
    ],
  );

  return {
    customizeLabel,
    description,
    footer,
    rows,
    onVisibleChange,
    onMove,
    showAllLabel,
    focusedLabel,
    restoreDefaultsLabel,
    showAll,
    applyFocused,
    restoreDefaults,
    canShowAll,
    canApplyFocused,
    canRestoreDefaults,
    settingsSection,
  };
}
