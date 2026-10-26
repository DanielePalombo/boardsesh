import { StyleSheet, View, type ColorValue } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { Climb } from '@boardsesh/queue';
import type { BoardName } from '@boardsesh/shared-schema';
import { useEffectiveClimbStats } from '@boardsesh/board-react';
import { useDisplayGrade } from '../../hooks/use-display-grade';
import { useTheme } from '../../providers/theme-provider';
import { useDrawerHost, type BoardConfig } from '../../providers/drawer-host-provider';
import { spacing } from '../../theme/tokens';
import { glassSize } from '../../theme/layout';
import { CHROME_LABEL_MAX_FONT_SCALE } from '../../theme/typography';
import { Text } from '../Text';
import { MarqueeText } from '../MarqueeText';
import { DraftChip } from '../DraftChip';
import { ACCESSORY_THUMBNAIL_SLOT_SIZE, AccessoryClimbThumbnail } from './AccessoryClimbThumbnail';
import { useAccessoryClimbTap } from './use-accessory-climb-tap';
import { AccessoryPlayLink } from './AccessoryPlayLink';
import { LargeContentViewer } from '../LargeContentViewer';
import { largeContentTitle } from './accessory-large-content-title';
import { LogAscentToolbarButton } from './LogAscentToolbarButton';
import { BoardControlIndicator } from './BoardControlIndicator';
import { formatQuality, formatSends } from '../../lib/format-climb-stats';

type AccessoryPlacement = 'regular' | 'inline';

type NativeAccessoryClimbRowProps = {
  climb: Climb;
  placement: AccessoryPlacement;
  /** Width of the open (regular) platter. The collapsed (inline) one fills its frame. */
  width: number;
  testID?: string;
};

// The platter's own edges. The trailing controls sit close to the right edge,
// like the play control in Apple Music's platter.
const ACCESSORY_LEADING_INSET = spacing[2];
const ACCESSORY_TRAILING_INSET = spacing[1];
// The collapsed platter is 44pt tall, so its thumbnail is smaller than the open one's.
const INLINE_THUMBNAIL_SIZE = 32;

type ClimbLabelProps = {
  climb: Climb;
  labelColor: ColorValue;
  bylineColor: ColorValue;
  byline: string | null;
  thumbnailSize: number | null;
  boardConfig: BoardConfig | null;
};

/**
 * Thumbnail, then the name over a byline, like a song over its artist in Apple
 * Music's platter: "V4 · 7.7k sends", or the rating when nobody has sent it.
 */
function ClimbLabel({ climb, labelColor, bylineColor, byline, thumbnailSize, boardConfig }: ClimbLabelProps) {
  return (
    <View style={styles.labelInner}>
      {thumbnailSize !== null ? (
        <AccessoryClimbThumbnail climb={climb} boardConfig={boardConfig} size={thumbnailSize} />
      ) : null}
      <View style={styles.titleBlock}>
        <View style={styles.titleLine}>
          {/* Scrolls a long name when it overflows (Reduce-Motion-gated). Falls
              back to tail-ellipsis when it fits or motion is off. */}
          <MarqueeText
            active
            variant="subheadline"
            color={labelColor}
            maxFontSizeMultiplier={CHROME_LABEL_MAX_FONT_SCALE}
            style={styles.name}
            textStyle={styles.nameText}
          >
            {climb.name}
          </MarqueeText>
          {/* A draft is missing from the Climbs list; the bar says why (#5954).
              The name beside it absorbs the truncation. */}
          {climb.is_draft === true ? (
            <DraftChip maxFontSizeMultiplier={CHROME_LABEL_MAX_FONT_SCALE} testID="accessory-climb-draft" />
          ) : null}
        </View>
        {byline ? (
          <Text
            variant="footnote"
            color={bylineColor}
            numberOfLines={1}
            maxFontSizeMultiplier={CHROME_LABEL_MAX_FONT_SCALE}
            style={styles.bylineText}
          >
            {byline}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

/** Grade · sends, or grade · rating when there are no sends; the grade alone otherwise. */
function useAccessoryByline(climb: Climb, boardConfig: BoardConfig | null, grade: string | null): string | null {
  const { t } = useTranslation('climbs');
  // The same live counts the list rows read, keyed on the climb's own board.
  const stats = useEffectiveClimbStats(
    (climb.boardType ?? boardConfig?.boardName ?? '') as BoardName,
    climb.layoutId ?? boardConfig?.layoutId ?? 0,
    climb.uuid,
    climb.angle,
    { ascensionistCount: climb.ascensionist_count, qualityAverage: climb.quality_average },
    { enabled: boardConfig !== null },
  );
  const isDraft = climb.is_draft === true;
  const sends = !isDraft && stats.ascensionistCount > 0 ? formatSends(stats.ascensionistCount, t) : null;
  const rating =
    stats.qualityAverage != null && parseFloat(stats.qualityAverage) > 0
      ? `${formatQuality(stats.qualityAverage)}★`
      : null;
  const parts = [grade, sends ?? rating].filter((part): part is string => !!part);
  return parts.length > 0 ? parts.join(' · ') : null;
}

/**
 * Content for the iOS 26 tab-bar bottom accessory (Liquid Glass variant only).
 * UIKit supplies the glass platter, so this stays bare: the current climb, then
 * the lightbulb (open platter only) and the tick at the trailing edge. The
 * displayed climb is resolved once by {@link QueueBottomAccessory} and passed in,
 * so this component never re-gates (a second gate could blank the live platter for
 * a frame, which UIKit snapshotted as doubled text). Tap-to-open is shared with
 * the floating capsule via useAccessoryClimbTap. Its plain grade + board thumbnail
 * are tuned for the platter, so they intentionally differ from the floating
 * capsule's colorized grade.
 */
export function NativeAccessoryClimbRow({ climb, placement, width, testID }: NativeAccessoryClimbRowProps) {
  const { boardConfig } = useDrawerHost();
  const { systemColors } = useTheme();
  const { resolveGrade } = useDisplayGrade();
  const { openPlay, preparePlay } = useAccessoryClimbTap();

  const isInline = placement === 'inline';
  const rowHeight = isInline ? glassSize.inline : glassSize.standard;
  const thumbnailSize = boardConfig === null ? null : isInline ? INLINE_THUMBNAIL_SIZE : ACCESSORY_THUMBNAIL_SLOT_SIZE;
  // The platter shows a plain (non-colorized) grade; only the label swaps to the
  // Boardsesh grade when the toggle is on and a trusted one exists.
  const currentFormattedGrade = resolveGrade(climb, boardConfig?.boardName).label;
  const byline = useAccessoryByline(climb, boardConfig, currentFormattedGrade);

  // UIKit can omit the central zoom-source subtree from its accessory AX tree.
  // CPP metadata belongs to this existing visible row; ordinary captures and
  // normal use leave each control's accessibility unchanged.
  return (
    <View
      // The collapsed (inline) platter is narrower than the open one: it shares the
      // collapsed bar with the selected tab (and, on iOS 27, the prominent Climbs tab).
      // Pinning it to the open width clipped its trailing tick, so inline fills the
      // frame UIKit gives it (react-native-screens sizes that root natively).
      style={[styles.row, { width: placement === 'regular' ? width : undefined, height: rowHeight }]}
      testID={testID}
      accessible={testID ? true : undefined}
      accessibilityLabel={testID ? climb.name : undefined}
    >
      <AccessoryPlayLink
        style={styles.tapClip}
        accessibilityLabel={climb.name}
        onOpen={openPlay}
        onPrepare={preparePlay}
        zoomSourceRetained
      >
        <LargeContentViewer
          style={styles.labelSlot}
          title={largeContentTitle(climb.name, currentFormattedGrade)}
          onActivate={openPlay}
        >
          <ClimbLabel
            climb={climb}
            labelColor={systemColors.label}
            bylineColor={systemColors.secondaryLabel}
            byline={byline}
            thumbnailSize={thumbnailSize}
            boardConfig={boardConfig}
          />
        </LargeContentViewer>
      </AccessoryPlayLink>
      {/* The trailing controls sit beside the climb gesture, never inside it, so
          their 44pt tap targets are never stolen by the row's tap. The lightbulb
          is the open platter's only: the collapsed one keeps the tick alone.
          Long-press on the bulb opens the controls sheet, as on the other
          lightbulbs now that a short press disconnects. */}
      {isInline ? null : (
        <View style={[styles.controlSlot, { width: glassSize.inline, height: rowHeight }]}>
          <BoardControlIndicator size={glassSize.inline} iconSize={22} enableLongPress />
        </View>
      )}
      <View style={[styles.controlSlot, { width: glassSize.inline, height: rowHeight }]}>
        <LogAscentToolbarButton climb={climb} size={glassSize.inline} iconSize={24} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingStart: ACCESSORY_LEADING_INSET,
    paddingEnd: ACCESSORY_TRAILING_INSET,
  },
  tapClip: {
    flex: 1,
    minWidth: 0,
    height: '100%',
    overflow: 'hidden',
    justifyContent: 'center',
  },
  labelSlot: {
    justifyContent: 'center',
    height: '100%',
  },
  labelInner: {
    flexDirection: 'row',
    alignItems: 'center',
    minWidth: 0,
    gap: spacing[2],
    paddingEnd: spacing[1],
  },
  titleBlock: {
    flex: 1,
    minWidth: 0,
    justifyContent: 'center',
  },
  titleLine: {
    flexDirection: 'row',
    alignItems: 'center',
    minWidth: 0,
    gap: spacing[2],
  },
  name: {
    flex: 1,
    minWidth: 0,
  },
  nameText: {
    fontWeight: '500',
  },
  bylineText: {
    fontVariant: ['tabular-nums'],
  },
  controlSlot: {
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
});
