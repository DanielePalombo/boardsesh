import { memo, useMemo } from 'react';
import {
  SectionLayoutSheetFooter,
  SectionLayoutSheetFrame,
  SectionLayoutSheetIntro,
  SectionLayoutSheetList,
  type SectionLayoutSheetAction,
} from '../section-layout/SectionLayoutSheet';
import { useHomeSectionControls } from './use-home-section-controls';

/**
 * Customize Home: a switch per section, ↑/↓ arrows for the ones above the feed,
 * Show all and Focused at the top, Restore defaults under the list. Choices
 * apply at once; Home redraws behind the sheet.
 */
export const HomeCustomizeSheet = memo(function HomeCustomizeSheet({
  visible,
  onClose,
}: {
  visible: boolean;
  onClose: () => void;
}) {
  const {
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
  } = useHomeSectionControls();
  const actions = useMemo<[SectionLayoutSheetAction, SectionLayoutSheetAction]>(
    () => [
      { label: showAllLabel, onPress: showAll, disabled: !canShowAll, testID: 'home-customize-show-all' },
      { label: focusedLabel, onPress: applyFocused, disabled: !canApplyFocused, testID: 'home-customize-focused' },
    ],
    [showAllLabel, showAll, canShowAll, focusedLabel, applyFocused, canApplyFocused],
  );
  const restoreAction = useMemo<SectionLayoutSheetAction>(
    () => ({
      label: restoreDefaultsLabel,
      onPress: restoreDefaults,
      disabled: !canRestoreDefaults,
      testID: 'home-customize-restore-defaults',
    }),
    [restoreDefaultsLabel, restoreDefaults, canRestoreDefaults],
  );
  const header = useMemo(
    () => <SectionLayoutSheetIntro description={description} actions={actions} />,
    [description, actions],
  );
  const listFooter = useMemo(
    () => <SectionLayoutSheetFooter guidance={footer} restoreDefaults={restoreAction} />,
    [footer, restoreAction],
  );
  return (
    <SectionLayoutSheetFrame visible={visible} onClose={onClose} title={customizeLabel} header={header}>
      <SectionLayoutSheetList
        rows={rows}
        onVisibleChange={onVisibleChange}
        onMove={onMove}
        ListFooterComponent={listFooter}
      />
    </SectionLayoutSheetFrame>
  );
});
