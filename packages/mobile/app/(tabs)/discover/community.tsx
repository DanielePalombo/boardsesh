import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { FlatList, RefreshControl, StyleSheet, View } from 'react-native';
import { router } from 'expo-router';
import { useTranslation } from 'react-i18next';
import {
  buildCommunityPlaylistsInput,
  clearCommunityPlaylistFilters,
  effectiveCommunityCreatorScope,
  hasActiveCommunityPlaylistFilters,
  useCommunityPlaylists,
  DEFAULT_COMMUNITY_PLAYLIST_FILTERS,
  type CommunityPlaylistCreatorScope,
  type CommunityPlaylistFilters,
  type CommunityPlaylistSize,
  type CommunityPlaylistSort,
} from '@boardsesh/playlists-react';
import type { DiscoverablePlaylist } from '@boardsesh/graphql/operations/playlists';
import { ReadableColumn } from '../../../src/components/ReadableColumn';
import { PressableSurface } from '../../../src/components/PressableSurface';
import { SearchField } from '../../../src/components/SearchField';
import { SegmentedControl } from '../../../src/components/SegmentedControl';
import type { SegmentOption } from '../../../src/components/SegmentedControl.types';
import { Text } from '../../../src/components/Text';
import { Icon } from '../../../src/components/Icon';
import { ActivityIndicator } from '../../../src/components/ActivityIndicator';
import { PlaylistListRow, PlaylistListRowSeparator } from '../../../src/components/playlist';
import { useAuth } from '../../../src/providers/auth-provider';
import { useTheme } from '../../../src/providers/theme-provider';
import { useProfile } from '../../../src/lib/graphql/hooks';
import { useActiveBoard } from '../../../src/lib/graphql/use-active-board';
import { useBottomChromeMetrics } from '../../../src/hooks/use-bottom-chrome-metrics';
import { usePullRefresh } from '../../../src/hooks/use-pull-refresh';
import { spacing } from '../../../src/theme/tokens';

const SEARCH_DEBOUNCE_MS = 300;
const PAGE_SIZE = 20;

function playlistKey(playlist: DiscoverablePlaylist): string {
  return playlist.uuid;
}

/**
 * The full Community Playlists list behind the Discover shelf's "See all":
 * one vertical, paginated list of public playlists on the active board, with a
 * title search, who made it, sort, and a climb-count band. Every filter lives
 * in one `CommunityPlaylistFilters` object; `buildCommunityPlaylistsInput`
 * turns it into server input, so adding a filter never touches the list.
 */
export default function CommunityPlaylistsScreen() {
  const { t } = useTranslation('playlists');
  const { systemColors, brandColors } = useTheme();
  const bottomChrome = useBottomChromeMetrics();
  const { isAuthenticated, isLoading: authLoading } = useAuth();
  const {
    data: profile,
    isLoading: profileLoading,
    refetch: refetchProfile,
  } = useProfile({ enabled: isAuthenticated });
  const { data: activeBoard, isLoading: activeBoardLoading } = useActiveBoard();

  const viewerId = isAuthenticated ? (profile?.id ?? null) : null;

  const [filters, setFilters] = useState<CommunityPlaylistFilters>(DEFAULT_COMMUNITY_PLAYLIST_FILTERS);
  // The field echoes every keystroke; `filters.search` follows after a pause so
  // typing a word costs one request, not one per letter.
  const [searchInput, setSearchInput] = useState('');
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    },
    [],
  );
  const handleSearchChange = useCallback((text: string) => {
    setSearchInput(text);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setFilters((previous) => (previous.search === text ? previous : { ...previous, search: text }));
    }, SEARCH_DEBOUNCE_MS);
  }, []);

  const setCreator = useCallback(
    (creator: CommunityPlaylistCreatorScope) => setFilters((previous) => ({ ...previous, creator })),
    [],
  );
  const setSort = useCallback((sort: CommunityPlaylistSort) => setFilters((previous) => ({ ...previous, sort })), []);
  const setSize = useCallback((size: CommunityPlaylistSize) => setFilters((previous) => ({ ...previous, size })), []);
  const clearFilters = useCallback(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    setSearchInput('');
    setFilters((previous) => clearCommunityPlaylistFilters(previous));
  }, []);

  const input = useMemo(
    () =>
      buildCommunityPlaylistsInput(filters, {
        viewerId,
        boardType: activeBoard?.boardType,
        layoutId: activeBoard?.layoutId,
      }),
    [filters, viewerId, activeBoard?.boardType, activeBoard?.layoutId],
  );

  // Hold the first request until the board and the viewer are known, so the
  // list doesn't fetch unscoped (or with the viewer's own playlists) and then
  // throw that page away. A signed-in viewer whose profile failed to load is
  // not "nobody": Everyone would show their own playlists, so that is an error.
  const viewerKnown = !isAuthenticated || profile != null;
  const profileFailed = isAuthenticated && !authLoading && !profileLoading && profile == null;
  const ready = !authLoading && !activeBoardLoading && viewerKnown;
  const {
    playlists,
    totalCount,
    isLoading,
    isLoadingMore,
    hasMore,
    hasError,
    hasLoadMoreError,
    loadMore,
    retryLoadMore,
    refetch,
  } = useCommunityPlaylists({ input, pageSize: PAGE_SIZE, enabled: ready });
  const pullRefresh = usePullRefresh(refetch, isLoading);

  const creatorScope = effectiveCommunityCreatorScope(filters, { viewerId });
  const filtersActive = hasActiveCommunityPlaylistFilters({ ...filters, creator: creatorScope });

  const creatorOptions = useMemo<SegmentOption<CommunityPlaylistCreatorScope>[]>(
    () => [
      { key: 'everyone', label: t('library.community.madeBy.everyone') },
      { key: 'mine', label: t('library.community.madeBy.mine') },
    ],
    [t],
  );
  const sortOptions = useMemo<SegmentOption<CommunityPlaylistSort>[]>(
    () => [
      { key: 'popular', label: t('library.community.sort.popular') },
      { key: 'recent', label: t('library.community.sort.recent') },
    ],
    [t],
  );
  const sizeOptions = useMemo<SegmentOption<CommunityPlaylistSize>[]>(
    () => [
      { key: 'any', label: t('library.community.size.any') },
      { key: 'short', label: t('library.community.size.short') },
      { key: 'session', label: t('library.community.size.session') },
      { key: 'big', label: t('library.community.size.big') },
    ],
    [t],
  );

  const goToPlaylist = useCallback((uuid: string) => {
    router.push(`/(tabs)/discover/${uuid}`);
  }, []);

  // `t` is the only non-stable input, and it changes only with the locale.
  const renderItem = useCallback(
    ({ item, index }: { item: DiscoverablePlaylist; index: number }) => (
      <PlaylistListRow
        uuid={item.uuid}
        name={item.name}
        climbCount={item.climbCount}
        color={item.color}
        icon={item.icon}
        index={index}
        meta={t('library.communityByline', {
          creatorName: item.creatorName,
          climbCount: t('detail.climbCount', { count: item.climbCount }),
        })}
        onPressUuid={goToPlaylist}
      />
    ),
    [goToPlaylist, t],
  );

  // One page per end-reach. The hook ignores a call while a page is in flight
  // or once the list is exhausted.
  const handleEndReached = useCallback(() => {
    if (hasMore) loadMore();
  }, [hasMore, loadMore]);

  // Until the board and viewer are known the hook is idle, which is still a load
  // from the climber's side, not an empty community.
  const showInitialLoad = (isLoading || (!ready && !profileFailed)) && playlists.length === 0;
  const showFirstPageError = (hasError || profileFailed) && !showInitialLoad && playlists.length === 0;
  // A failed pull-to-refresh keeps the rows; the footer offers the retry.
  const showRefreshError = hasError && !isLoading && playlists.length > 0;

  const retryFirstPage = useCallback(() => {
    if (profileFailed) void refetchProfile();
    else refetch();
  }, [profileFailed, refetch, refetchProfile]);

  // The count only appears beside rows; the empty states already say "none".
  const summaryParts: string[] = [];
  if (playlists.length > 0) {
    summaryParts.push(t('library.community.resultCount', { count: totalCount }));
  }
  if (filters.size === 'short') summaryParts.push(t('library.community.sizeBand.short'));
  else if (filters.size === 'session') summaryParts.push(t('library.community.sizeBand.session'));
  else if (filters.size === 'big') summaryParts.push(t('library.community.sizeBand.big'));
  const summary = summaryParts.join(' · ');

  let listEmpty: ReactElement;
  if (showInitialLoad) {
    listEmpty = (
      <View style={[styles.centered, styles.stateBlock]}>
        <ActivityIndicator size="large" />
      </View>
    );
  } else if (showFirstPageError) {
    listEmpty = (
      <View style={[styles.centered, styles.stateBlock]}>
        <Icon name="error" size={48} color={systemColors.tertiaryLabel} />
        <Text variant="headline" style={styles.stateTitle}>
          {t('library.community.errors.loadTitle')}
        </Text>
        <Text variant="subheadline" style={styles.stateSubtitle}>
          {t('library.community.errors.loadDescription')}
        </Text>
        <PressableSurface
          onPress={retryFirstPage}
          accessibilityRole="button"
          accessibilityLabel={t('library.errors.tryAgain')}
          hitSlop={8}
        >
          <Text variant="subheadline" color={brandColors.primary} style={styles.stateCta}>
            {t('library.errors.tryAgain')}
          </Text>
        </PressableSurface>
      </View>
    );
  } else if (filtersActive) {
    listEmpty = (
      <View style={[styles.centered, styles.stateBlock]}>
        <Icon name="search" size={48} color={systemColors.tertiaryLabel} />
        <Text variant="headline" style={styles.stateTitle}>
          {t('library.community.noMatches.title')}
        </Text>
        <Text variant="subheadline" style={styles.stateSubtitle}>
          {t('library.community.noMatches.description')}
        </Text>
        <PressableSurface
          onPress={clearFilters}
          accessibilityRole="button"
          accessibilityLabel={t('library.community.noMatches.clearFilters')}
          hitSlop={8}
        >
          <Text variant="subheadline" color={brandColors.primary} style={styles.stateCta}>
            {t('library.community.noMatches.clearFilters')}
          </Text>
        </PressableSurface>
      </View>
    );
  } else {
    listEmpty = (
      <View style={[styles.centered, styles.stateBlock]}>
        <Icon name="playlist" size={48} color={systemColors.tertiaryLabel} />
        <Text variant="headline" style={styles.stateTitle}>
          {t('library.community.empty.title')}
        </Text>
        <Text variant="subheadline" style={styles.stateSubtitle}>
          {t('library.community.empty.description')}
        </Text>
      </View>
    );
  }

  return (
    <View style={[styles.flex, { backgroundColor: systemColors.background }]}>
      <ReadableColumn style={styles.readableViewport}>
        <View style={styles.filterBar}>
          <SearchField
            value={searchInput}
            onChangeText={handleSearchChange}
            placeholder={t('library.community.searchPlaceholder')}
            clearAccessibilityLabel={t('library.allPlaylists.clearSearch')}
          />
          {viewerId ? (
            <SegmentedControl
              options={creatorOptions}
              selectedKey={creatorScope}
              onSelect={setCreator}
              accessibilityLabel={t('library.community.madeByLabel')}
            />
          ) : null}
          <SegmentedControl
            options={sortOptions}
            selectedKey={filters.sort}
            onSelect={setSort}
            accessibilityLabel={t('library.community.sortLabel')}
          />
          <SegmentedControl
            options={sizeOptions}
            selectedKey={filters.size}
            onSelect={setSize}
            accessibilityLabel={t('library.community.sizeLabel')}
          />
          {summary.length > 0 ? (
            <Text variant="footnote" color={systemColors.secondaryLabel} style={styles.summary}>
              {summary}
            </Text>
          ) : null}
        </View>

        <FlatList
          data={playlists}
          keyExtractor={playlistKey}
          renderItem={renderItem}
          ItemSeparatorComponent={PlaylistListRowSeparator}
          onEndReached={handleEndReached}
          onEndReachedThreshold={0.5}
          contentContainerStyle={{ paddingBottom: bottomChrome.scrollBottomPadding + spacing[6] }}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          refreshControl={
            <RefreshControl
              refreshing={pullRefresh.refreshing}
              onRefresh={pullRefresh.onRefresh}
              tintColor={brandColors.primary}
            />
          }
          ListEmptyComponent={listEmpty}
          ListFooterComponent={
            showRefreshError ? (
              <PressableSurface
                style={styles.footer}
                onPress={refetch}
                accessibilityRole="button"
                accessibilityLabel={`${t('library.community.errors.loadTitle')} ${t('library.errors.tryAgain')}`}
              >
                <Text variant="footnote" color={systemColors.secondaryLabel} style={styles.footerError}>
                  {t('library.community.errors.loadTitle')}
                </Text>
                <Text variant="subheadline" color={brandColors.primary} style={styles.footerRetry}>
                  {t('library.errors.tryAgain')}
                </Text>
              </PressableSurface>
            ) : hasLoadMoreError ? (
              <PressableSurface
                style={styles.footer}
                onPress={retryLoadMore}
                accessibilityRole="button"
                accessibilityLabel={`${t('library.community.loadMoreError')} ${t('library.errors.tryAgain')}`}
              >
                <Text variant="footnote" color={systemColors.secondaryLabel} style={styles.footerError}>
                  {t('library.community.loadMoreError')}
                </Text>
                <Text variant="subheadline" color={brandColors.primary} style={styles.footerRetry}>
                  {t('library.errors.tryAgain')}
                </Text>
              </PressableSurface>
            ) : isLoadingMore ? (
              <View style={styles.footer}>
                <ActivityIndicator size="small" />
              </View>
            ) : null
          }
        />
      </ReadableColumn>
    </View>
  );
}

// Drops the empty / error block below the filters toward the optical centre.
const STATE_BLOCK_TOP_INSET = spacing[16];

const styles = StyleSheet.create({
  readableViewport: { flex: 1, minHeight: 0, minWidth: 0 },
  flex: {
    flex: 1,
  },
  centered: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  filterBar: {
    paddingHorizontal: spacing[4],
    paddingTop: spacing[2],
    paddingBottom: spacing[2],
    gap: spacing[2],
  },
  summary: {
    paddingTop: spacing[1],
  },
  stateBlock: {
    paddingTop: STATE_BLOCK_TOP_INSET,
    paddingHorizontal: spacing[8],
    gap: spacing[2],
  },
  stateTitle: {
    marginTop: spacing[3],
    opacity: 0.6,
    textAlign: 'center',
  },
  stateSubtitle: {
    opacity: 0.4,
    textAlign: 'center',
  },
  stateCta: {
    marginTop: spacing[3],
    fontWeight: '600',
  },
  footer: {
    paddingVertical: spacing[4],
    alignItems: 'center',
  },
  footerError: {
    textAlign: 'center',
  },
  footerRetry: {
    marginTop: spacing[1],
    fontWeight: '600',
  },
});
