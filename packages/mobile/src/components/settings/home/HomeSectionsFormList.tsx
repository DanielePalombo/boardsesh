import { Fragment, memo, useCallback, type ReactNode } from 'react';
import { Platform, StyleSheet, View, type FlatListProps, type LayoutChangeEvent } from 'react-native';
import { Surface } from 'react-native-paper';
import {
  SectionLayoutList,
  type PlacedSectionLayoutRow,
  type SectionLayoutRowModel,
  type SectionMoveHandler,
} from '../../section-layout/SectionLayoutList';
import type { HomeSectionId } from '../../../lib/home-sections';
import { spacing } from '../../../theme/tokens';

type HomeSectionRow = PlacedSectionLayoutRow<HomeSectionId>;

const NO_SEPARATORS = { highlight: () => {}, unhighlight: () => {}, updateProps: () => {} };

/**
 * Every row at once, with no scroller of its own: the Settings form around it
 * scrolls. Five rows at most, so there is nothing to virtualise.
 */
function StaticRowList({ data, renderItem, keyExtractor }: FlatListProps<HomeSectionRow>) {
  const rows = Array.from(data ?? []);
  return (
    <View>
      {rows.map((item, index) => (
        <Fragment key={keyExtractor ? keyExtractor(item, index) : item.id}>
          {renderItem?.({ item, index, separators: NO_SEPARATORS })}
        </Fragment>
      ))}
    </View>
  );
}

type HomeSectionsFormListProps = {
  /** The sections that move: everything but the feed, in the climber's order. */
  rows: readonly SectionLayoutRowModel<HomeSectionId>[];
  onVisibleChange: (sectionId: HomeSectionId, visible: boolean) => void;
  onMove: SectionMoveHandler<HomeSectionId>;
  /** The list's drawn height, for the form row that hosts it (Dynamic Type grows it). */
  onHeightChange: (height: number) => void;
};

/**
 * Settings › Home's reorderable rows (Marco's ask on #6546): the Customize Home
 * sheet's switch-and-arrows rows, hosted in the native Settings form as its one
 * React Native row, since the form has no reorderable row of its own. The rows
 * sit on the form's card on iOS and Android. The browser's full-bleed row has
 * no card and bleeds to the screen edge, so there they draw the browser form's
 * own card (Paper `Surface`, as `MoreForm.web` does) inset back to the others.
 */
export const HomeSectionsFormList = memo(function HomeSectionsFormList({
  rows,
  onVisibleChange,
  onMove,
  onHeightChange,
}: HomeSectionsFormListProps) {
  const handleLayout = useCallback(
    (event: LayoutChangeEvent) => {
      const drawnHeight = Math.ceil(event.nativeEvent.layout.height);
      // A host that has not been laid out yet reports nothing; keep the guess.
      if (drawnHeight > 0) onHeightChange(drawnHeight);
    },
    [onHeightChange],
  );
  return (
    <View onLayout={handleLayout} testID="home-settings-sections">
      <BrowserCard>
        <SectionLayoutList
          ListComponent={StaticRowList}
          rows={rows}
          rowBackgroundColor="transparent"
          onVisibleChange={onVisibleChange}
          onMove={onMove}
        />
      </BrowserCard>
    </View>
  );
});

/** The browser form's card, inset to cancel the full-bleed row's margin. Native forms draw their own. */
function BrowserCard({ children }: { children: ReactNode }) {
  if (Platform.OS !== 'web') return children;
  return (
    <Surface style={styles.browserCard} elevation={1}>
      {children}
    </Surface>
  );
}

const styles = StyleSheet.create({
  // MoreForm.web's `card`, plus the `spacing[4]` its `fullBleed` takes away.
  browserCard: { marginHorizontal: spacing[4], borderRadius: 12, overflow: 'hidden' },
});
