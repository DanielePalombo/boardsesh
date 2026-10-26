import { View } from 'react-native';

/**
 * An empty title view for a native stack header. UIKit draws no title text while
 * the navigation item keeps its `title`, so the back button's long-press menu
 * still names the screen. VoiceOver reads no heading in the bar; the selected tab
 * names the screen. A renderer that returns `null` would not do: with no title
 * view, the native stack falls back to drawing `title` in the bar. Module-level,
 * so the option keeps one identity across renders.
 */
export function renderHiddenHeaderTitle() {
  return <View />;
}
