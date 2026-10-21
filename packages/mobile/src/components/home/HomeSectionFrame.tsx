import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { Text } from '../Text';
import { spacing } from '../../theme/tokens';

/**
 * A Home card under its heading, spaced like the Climbing now rail so the
 * sections read as one column whatever order the climber picks.
 */
export function HomeSectionFrame({ title, testID, children }: { title: string; testID: string; children: ReactNode }) {
  return (
    <View style={styles.section} testID={testID}>
      <Text variant="title3" accessibilityRole="header" style={styles.heading}>
        {title}
      </Text>
      <View style={styles.body}>{children}</View>
    </View>
  );
}

/** The grouped rows inside a Home card: each row owns the card's 16-point gutter, so all of it is tappable. */
export const homeCardRowStyles = StyleSheet.create({
  rows: {
    margin: -spacing[4],
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[3],
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[3],
    minHeight: spacing[12],
  },
  leading: {
    width: 44,
    flexShrink: 0,
    alignItems: 'center',
  },
  text: {
    flex: 1,
    minWidth: 0,
    gap: spacing[1],
  },
  separator: {
    height: StyleSheet.hairlineWidth,
    marginStart: spacing[4] + 44 + spacing[3],
  },
});

const styles = StyleSheet.create({
  section: {
    paddingBottom: spacing[5],
  },
  heading: {
    paddingHorizontal: spacing[4],
    paddingBottom: spacing[2],
  },
  body: {
    paddingHorizontal: spacing[4],
  },
});
