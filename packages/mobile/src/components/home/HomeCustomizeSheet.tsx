import { useMemo, type ComponentType } from 'react';
import { Platform, StyleSheet, View, type FlatListProps } from 'react-native';
import { BottomSheetFlatList } from '@expo/ui/community/bottom-sheet';
import { ModalSheet } from '../ModalSheet';
import { SheetTopBar } from '../SheetTopBar';
import { Button } from '../Button';
import { Text } from '../Text';
import { MEDIUM_LARGE_SNAP_POINTS } from '../sheet-snap-points';
import { useIosSheetBackgroundStyle } from '../use-ios-sheet-background-style';
import { SectionLayoutList, type PlacedSectionLayoutRow } from '../section-layout/SectionLayoutList';
import type { HomeSectionId } from '../../lib/home-sections';
import { useTheme } from '../../providers/theme-provider';
import { spacing } from '../../theme/tokens';
import { useHomeSectionControls } from './use-home-section-controls';

const SheetFlatList = BottomSheetFlatList as ComponentType<FlatListProps<PlacedSectionLayoutRow<HomeSectionId>>>;

/**
 * Customize Home: a switch per section, ↑/↓ arrows for the four above the
 * feed, Show all and Focused at the top, Restore defaults under the list.
 * Choices apply at once; Home redraws behind the sheet.
 */
export function HomeCustomizeSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
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
  const { systemColors } = useTheme();
  const iosBackgroundStyle = useIosSheetBackgroundStyle();
  // Leave the native sheet material visible on Apple's sheet; only the inset
  // switch group needs an opaque surface (as in the climb's View options).
  const contentGround =
    Platform.OS === 'ios' && iosBackgroundStyle === undefined
      ? undefined
      : { backgroundColor: systemColors.groupedBackground };
  const listFooter = useMemo(
    () => (
      <View style={styles.footer}>
        <Text variant="footnote" color={systemColors.secondaryLabel} style={styles.guidance}>
          {footer}
        </Text>
        <View style={styles.restoreDefaults}>
          <Button
            title={restoreDefaultsLabel}
            onPress={restoreDefaults}
            disabled={!canRestoreDefaults}
            haptic={false}
            variant="text"
            minHeight={44}
            testID="home-customize-restore-defaults"
          />
        </View>
      </View>
    ),
    [footer, systemColors.secondaryLabel, restoreDefaultsLabel, restoreDefaults, canRestoreDefaults],
  );
  return (
    <ModalSheet
      visible={visible}
      onClose={onClose}
      snapPoints={MEDIUM_LARGE_SNAP_POINTS}
      scrollable={false}
      surface="solid"
      header={
        <View>
          <SheetTopBar title={customizeLabel} leading={{ kind: 'close', onPress: onClose }} />
          <View style={[styles.headerControls, contentGround]}>
            <Text variant="subheadline" color={systemColors.secondaryLabel}>
              {description}
            </Text>
            <View style={styles.actions}>
              <View style={styles.actionSlot}>
                <Button
                  title={showAllLabel}
                  onPress={showAll}
                  disabled={!canShowAll}
                  haptic={false}
                  variant="text"
                  style={styles.actionButton}
                  minHeight={44}
                  testID="home-customize-show-all"
                />
              </View>
              <View style={styles.actionSlot}>
                <Button
                  title={focusedLabel}
                  onPress={applyFocused}
                  disabled={!canApplyFocused}
                  haptic={false}
                  variant="text"
                  style={styles.actionButton}
                  minHeight={44}
                  testID="home-customize-focused"
                />
              </View>
            </View>
          </View>
        </View>
      }
    >
      <SectionLayoutList
        ListComponent={SheetFlatList}
        style={[styles.list, contentGround]}
        contentContainerStyle={styles.listContent}
        rows={rows}
        onVisibleChange={onVisibleChange}
        onMove={onMove}
        ListFooterComponent={listFooter}
      />
    </ModalSheet>
  );
}

const styles = StyleSheet.create({
  list: { flex: 1 },
  listContent: { paddingHorizontal: spacing[4] },
  headerControls: { paddingHorizontal: spacing[4], paddingTop: spacing[3], paddingBottom: spacing[2], gap: spacing[2] },
  actions: { flexDirection: 'row', gap: spacing[2] },
  actionSlot: { flex: 1 },
  actionButton: { width: '100%' },
  footer: { paddingVertical: spacing[3], gap: spacing[2] },
  guidance: { paddingHorizontal: spacing[4] },
  // Lines the action up with the guidance above it.
  restoreDefaults: { paddingHorizontal: spacing[4] },
});
