import { memo, useCallback } from 'react';
import { View } from 'react-native';
import { useIsFocused } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { Card } from '../Card';
import { Icon } from '../Icon';
import { PressableSurface } from '../PressableSurface';
import { Text } from '../Text';
import { SessionTimer } from '../session-screen/in-session/SessionTimer';
import { useScopedRouter as useRouter } from '../../lib/routing/scoped-navigation';
import { useIsAppBackgrounded } from '../../lib/app-visibility';
import { useSessionSummary } from '../../lib/graphql/hooks';
import { hapticLight } from '../../lib/haptics';
import { useQueueSessionId } from '../../providers/queue-provider';
import { useTheme } from '../../providers/theme-provider';
import { HomeSectionFrame, homeCardRowStyles } from './HomeSectionFrame';

/**
 * "Session": Start a session, or the running session's timer and Open session.
 * Both go to the Session tab, where workouts, End and the stats live.
 *
 * The session id is local, so the card shows with no signal. The timer needs
 * the session's start time from the server and stays hidden until it loads.
 */
export const HomeSessionSection = memo(function HomeSessionSection() {
  const { t } = useTranslation('feed');
  const { t: tCommon } = useTranslation('common');
  const router = useRouter();
  const { systemColors, brandColors } = useTheme();
  const { sessionId } = useQueueSessionId();
  // The Session tab's own query key, so the two share one cached answer.
  const summaryQuery = useSessionSummary(sessionId);
  const startedAt = summaryQuery.data?.startedAt ?? null;
  // The timer ticks only while Home is on screen.
  const isFocused = useIsFocused();
  const backgrounded = useIsAppBackgrounded();
  const timerTicking = isFocused && !backgrounded;

  const openSessionTab = useCallback(() => {
    hapticLight();
    router.navigate('/(tabs)/record');
  }, [router]);

  return (
    <HomeSectionFrame title={tCommon('mobile.settings.homeSections.sections.session')} testID="home-section-session">
      <Card>
        <View style={homeCardRowStyles.rows}>
          {sessionId ? (
            <>
              <View style={homeCardRowStyles.row} accessible>
                <View style={homeCardRowStyles.leading}>
                  <Icon name="record" size={24} color={brandColors.primary} />
                </View>
                <View style={homeCardRowStyles.text}>
                  <Text variant="footnote" color={systemColors.secondaryLabel}>
                    {t('mobile.home.sections.session.running')}
                  </Text>
                  {timerTicking ? <SessionTimer startedAt={startedAt} /> : null}
                </View>
              </View>
              <View style={[homeCardRowStyles.separator, { backgroundColor: systemColors.separator }]} />
              <PressableSurface
                onPress={openSessionTab}
                feedback="opacity"
                rippleColor={systemColors.label as string}
                accessibilityRole="button"
                accessibilityLabel={t('mobile.home.sections.session.open')}
                style={homeCardRowStyles.row}
                testID="home-session-open"
              >
                <View style={homeCardRowStyles.leading}>
                  <Icon name="play.circle" size={20} color={systemColors.secondaryLabel} />
                </View>
                <Text variant="body" color={systemColors.label} style={homeCardRowStyles.text}>
                  {t('mobile.home.sections.session.open')}
                </Text>
                <Icon name="chevron.right" size={16} color={systemColors.tertiaryLabel} />
              </PressableSurface>
            </>
          ) : (
            <PressableSurface
              onPress={openSessionTab}
              feedback="opacity"
              rippleColor={systemColors.label as string}
              accessibilityRole="button"
              accessibilityLabel={[
                t('mobile.home.sections.session.startTitle'),
                t('mobile.home.sections.session.startBody'),
              ].join(', ')}
              style={homeCardRowStyles.row}
              testID="home-session-start"
            >
              <View style={homeCardRowStyles.leading}>
                <Icon name="record" size={24} color={brandColors.primary} />
              </View>
              <View style={homeCardRowStyles.text}>
                <Text variant="headline" color={systemColors.label}>
                  {t('mobile.home.sections.session.startTitle')}
                </Text>
                <Text variant="subheadline" color={systemColors.secondaryLabel}>
                  {t('mobile.home.sections.session.startBody')}
                </Text>
              </View>
              <Icon name="chevron.right" size={16} color={systemColors.tertiaryLabel} />
            </PressableSurface>
          )}
        </View>
      </Card>
    </HomeSectionFrame>
  );
});
