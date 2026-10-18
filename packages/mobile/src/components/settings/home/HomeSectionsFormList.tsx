import { Fragment, memo, useCallback } from 'react';
import { Platform, View, type FlatListProps, type LayoutChangeEvent } from 'react-native';
import {
  SectionLayoutList,
  type PlacedSectionLayoutRow,
  type SectionLayoutRowModel,
  type SectionMoveHandler,
} from '../../section-layout/SectionLayoutList';
import type { HomeSectionId } from '../../../lib/home-sections';
import { useTheme } from '../../../providers/theme-provider';

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
 * sit on the form's card on iOS and Android; the browser's full-bleed row has
 * no card, so there they keep their own grouped surface.
 */
export const HomeSectionsFormList = memo(function HomeSectionsFormList({
  rows,
  onVisibleChange,
  onMove,
  onHeightChange,
}: HomeSectionsFormListProps) {
  const { systemColors } = useTheme();
  const handleLayout = useCallback(
    (event: LayoutChangeEvent) => onHeightChange(Math.ceil(event.nativeEvent.layout.height)),
    [onHeightChange],
  );
  return (
    <View onLayout={handleLayout} testID="home-settings-sections">
      <SectionLayoutList
        ListComponent={StaticRowList}
        rows={rows}
        rowBackgroundColor={Platform.OS === 'web' ? systemColors.secondaryGroupedBackground : 'transparent'}
        onVisibleChange={onVisibleChange}
        onMove={onMove}
      />
    </View>
  );
});
