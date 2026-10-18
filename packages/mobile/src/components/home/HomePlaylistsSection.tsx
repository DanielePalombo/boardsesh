import { memo, useCallback, useMemo } from 'react';
import { View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useSmartPlaylistCounts } from '@boardsesh/playlists-react';
import type { SmartPlaylistType } from '@boardsesh/graphql/operations/playlists';
import { Card } from '../Card';
import { Icon } from '../Icon';
import { PressableSurface } from '../PressableSurface';
import { Text } from '../Text';
import { PlaylistPreviewSquare } from '../playlist/PlaylistPreviewSquare';
import { useScopedRouter as useRouter } from '../../lib/routing/scoped-navigation';
import { useAuthToken } from '../../lib/graphql/use-auth-token';
import { hapticLight } from '../../lib/haptics';
import { smartPlaylistByType, smartPlaylistHref, type SmartPlaylistPresentation } from '../../lib/smart-playlists';
import { useAuth } from '../../providers/auth-provider';
import { useTheme } from '../../providers/theme-provider';
import { HomeSectionFrame, homeCardRowStyles } from './HomeSectionFrame';

// The two lists a climber keeps coming back to, as on Boardz's Home. Choosing
// which lists show here is a later change.
const HOME_SMART_PLAYLIST_TYPES: readonly SmartPlaylistType[] = ['LIKED_CLIMBS', 'PROJECTS'];
const HOME_SMART_PLAYLISTS = HOME_SMART_PLAYLIST_TYPES.flatMap((type) => smartPlaylistByType(type) ?? []);
const PREVIEW_SIZE = 44;

/**
 * "Playlists": Liked climbs and Projects, then All playlists on Discover.
 *
 * The counts come from the network. Without them (no signal, still loading)
 * the rows show without a count, and each list shows its own offline state.
 */
export const HomePlaylistsSection = memo(function HomePlaylistsSection() {
  const { t } = useTranslation('playlists');
  const { t: tFeed } = useTranslation('feed');
  const { t: tCommon } = useTranslation('common');
  const router = useRouter();
  const { systemColors } = useTheme();
  const { isAuthenticated } = useAuth();
  const { data: token = null, isLoading: tokenLoading } = useAuthToken();
  // Discover's own query key, so a visit to either warms the other.
  const countsQuery = useSmartPlaylistCounts({ token, tokenLoading, isAuthenticated });
  const countByType = useMemo(
    () => new Map((countsQuery.data ?? []).map((smartCount) => [smartCount.type, smartCount.count])),
    [countsQuery.data],
  );

  const openSmartPlaylist = useCallback(
    (smartType: SmartPlaylistType) => {
      hapticLight();
      router.push(smartPlaylistHref(smartType, 'home'));
    },
    [router],
  );
  const openAllPlaylists = useCallback(() => {
    hapticLight();
    router.navigate('/(tabs)/discover');
  }, [router]);

  const allPlaylistsLabel = tFeed('mobile.home.sections.playlists.all');
  return (
    <HomeSectionFrame
      title={tCommon('mobile.settings.homeSections.sections.playlists')}
      testID="home-section-playlists"
    >
      <Card>
        <View style={homeCardRowStyles.rows}>
          {HOME_SMART_PLAYLISTS.map((preset) => {
            const count = countByType.get(preset.type);
            return (
              <SmartPlaylistRow
                key={preset.type}
                preset={preset}
                name={t(preset.titleI18nKey)}
                countLabel={count === undefined ? null : t('detail.climbCount', { count })}
                onOpen={openSmartPlaylist}
              />
            );
          })}
          <PressableSurface
            onPress={openAllPlaylists}
            feedback="opacity"
            rippleColor={systemColors.label as string}
            accessibilityRole="button"
            accessibilityLabel={allPlaylistsLabel}
            style={homeCardRowStyles.row}
            testID="home-playlists-all"
          >
            <View style={homeCardRowStyles.leading}>
              <Icon name="discover" size={20} color={systemColors.secondaryLabel} />
            </View>
            <Text variant="body" color={systemColors.label} style={homeCardRowStyles.text}>
              {allPlaylistsLabel}
            </Text>
            <Icon name="chevron.right" size={16} color={systemColors.tertiaryLabel} />
          </PressableSurface>
        </View>
      </Card>
    </HomeSectionFrame>
  );
});

const SmartPlaylistRow = memo(function SmartPlaylistRow({
  preset,
  name,
  countLabel,
  onOpen,
}: {
  preset: SmartPlaylistPresentation;
  name: string;
  countLabel: string | null;
  onOpen: (smartType: SmartPlaylistType) => void;
}) {
  const { systemColors } = useTheme();
  const { type } = preset;
  const handlePress = useCallback(() => onOpen(type), [onOpen, type]);
  return (
    <>
      <PressableSurface
        onPress={handlePress}
        feedback="opacity"
        rippleColor={systemColors.label as string}
        accessibilityRole="button"
        accessibilityLabel={countLabel ? `${name}, ${countLabel}` : name}
        style={homeCardRowStyles.row}
        testID={`home-playlists-${preset.slug}`}
      >
        <View style={homeCardRowStyles.leading} accessibilityElementsHidden importantForAccessibility="no">
          <PlaylistPreviewSquare color={preset.color} icon={preset.icon} size={PREVIEW_SIZE} />
        </View>
        <View style={homeCardRowStyles.text}>
          <Text variant="headline" color={systemColors.label}>
            {name}
          </Text>
          {countLabel ? (
            <Text variant="subheadline" color={systemColors.secondaryLabel}>
              {countLabel}
            </Text>
          ) : null}
        </View>
        <Icon name="chevron.right" size={16} color={systemColors.tertiaryLabel} />
      </PressableSurface>
      <View style={[homeCardRowStyles.separator, { backgroundColor: systemColors.separator }]} />
    </>
  );
});
