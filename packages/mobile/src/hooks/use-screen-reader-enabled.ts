import { useEffect, useState } from 'react';
import { AccessibilityInfo } from 'react-native';

/**
 * True while VoiceOver (iOS) or TalkBack (Android) is running.
 *
 * iOS tells React Native nothing about Voice Control, Switch Control or Full
 * Keyboard Access, so a false here does not mean nobody relies on the
 * accessibility tree.
 */
export function useScreenReaderEnabled(): boolean {
  const [screenReaderEnabled, setScreenReaderEnabled] = useState(false);

  useEffect(() => {
    let mounted = true;
    AccessibilityInfo.isScreenReaderEnabled()
      .then((enabled) => {
        if (mounted) setScreenReaderEnabled(enabled);
      })
      .catch(() => {});
    const subscription = AccessibilityInfo.addEventListener('screenReaderChanged', setScreenReaderEnabled);
    return () => {
      mounted = false;
      subscription.remove();
    };
  }, []);

  return screenReaderEnabled;
}
