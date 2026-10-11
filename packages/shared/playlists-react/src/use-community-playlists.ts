import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  DISCOVER_PLAYLISTS,
  type DiscoverablePlaylist,
  type DiscoverPlaylistsInput,
  type DiscoverPlaylistsQueryResponse,
} from '@boardsesh/graphql/operations/playlists';
import { usePlaylistsAdapter, type ExecutePlaylistsGraphQL } from './adapter';
import type { CommunityPlaylistsInput } from './community-playlist-filters';

export type UseCommunityPlaylistsOptions = {
  /**
   * Server input without the page cursor, usually from
   * `buildCommunityPlaylistsInput`. Compared by content, so a fresh object with
   * the same fields does not refetch; any changed field resets to page 0.
   */
  input: CommunityPlaylistsInput;
  /** Page size per request. Defaults to 20. */
  pageSize?: number;
  /** Whether requests should run. Defaults to true. */
  enabled?: boolean;
  /** Override the adapter's `executeGraphQL` (used in tests). */
  executeGraphQL?: ExecutePlaylistsGraphQL;
};

export type UseCommunityPlaylistsResult = {
  playlists: DiscoverablePlaylist[];
  /** Server total for the current input. 0 until the first page lands. */
  totalCount: number;
  isLoading: boolean;
  isLoadingMore: boolean;
  hasMore: boolean;
  /** The first page for the current input failed. */
  hasError: boolean;
  /** Pages 2+ failed three times in a row; `retryLoadMore` re-arms them. */
  hasLoadMoreError: boolean;
  /** Fetches the next page. One page per call, never a drain. */
  loadMore: () => void;
  retryLoadMore: () => void;
  refetch: () => void;
};

const MAX_LOAD_MORE_FAILURES = 3;

/**
 * One sorted, filtered, paginated stream of public playlists — the full
 * Community Playlists list. Unlike `useDiscoverPlaylists` (two merged streams
 * for the hub shelf), this fetches a single `sortBy`, so the order the climber
 * picked is the order they see.
 *
 *  - Any change to `input` drops the loaded rows and fetches page 0. A response
 *    for an older input is discarded, so fast typing can't land stale rows.
 *  - Offset pages can shift between requests (a playlist gains a pin and moves
 *    up), so appended rows are de-duplicated by uuid.
 *  - Three consecutive loadMore failures stop pagination and raise
 *    `hasLoadMoreError` instead of retrying forever on every end-reach.
 */
export function useCommunityPlaylists({
  input,
  pageSize = 20,
  enabled = true,
  executeGraphQL: executeGraphQLOverride,
}: UseCommunityPlaylistsOptions): UseCommunityPlaylistsResult {
  const adapter = usePlaylistsAdapter();
  const executeGraphQL = executeGraphQLOverride ?? adapter.executeGraphQL;

  // Content key, so callers don't have to memoise the input object.
  const inputKey = JSON.stringify(input);
  const stableInput = useMemo(() => JSON.parse(inputKey) as CommunityPlaylistsInput, [inputKey]);

  const [playlists, setPlaylists] = useState<DiscoverablePlaylist[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [isLoading, setIsLoading] = useState(enabled);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [hasError, setHasError] = useState(false);
  const [hasLoadMoreError, setHasLoadMoreError] = useState(false);

  const pageRef = useRef(0);
  const hasMoreRef = useRef(false);
  const isFetchingRef = useRef(false);
  const activeFetchIdRef = useRef(0);
  const loadMoreFailCountRef = useRef(0);

  const fetchPage = useCallback(
    async (page: number, isInitial: boolean) => {
      if (!enabled) return;
      if (!isInitial && isFetchingRef.current) return;

      const fetchId = activeFetchIdRef.current + 1;
      activeFetchIdRef.current = fetchId;
      isFetchingRef.current = true;

      if (isInitial) {
        setIsLoading(true);
        setIsLoadingMore(false);
      } else {
        setIsLoadingMore(true);
      }

      try {
        const response = await executeGraphQL<DiscoverPlaylistsQueryResponse, { input: DiscoverPlaylistsInput }>(
          DISCOVER_PLAYLISTS,
          { input: { ...stableInput, page, pageSize } },
        );
        if (activeFetchIdRef.current !== fetchId) return;

        const { playlists: pagePlaylists, totalCount: total, hasMore: more } = response.discoverPlaylists;
        setPlaylists((previous) => {
          if (isInitial) return pagePlaylists;
          const seen = new Set(previous.map((playlist) => playlist.uuid));
          const fresh = pagePlaylists.filter((playlist) => !seen.has(playlist.uuid));
          return fresh.length > 0 ? [...previous, ...fresh] : previous;
        });
        setTotalCount(total);
        setHasMore(more);
        hasMoreRef.current = more;
        pageRef.current = page + 1;
        loadMoreFailCountRef.current = 0;
        setHasError(false);
        setHasLoadMoreError(false);
      } catch (err: unknown) {
        if (activeFetchIdRef.current !== fetchId) return;
        console.error('Failed to fetch community playlists:', err);
        if (isInitial) {
          setHasError(true);
        } else {
          loadMoreFailCountRef.current += 1;
          if (loadMoreFailCountRef.current >= MAX_LOAD_MORE_FAILURES) {
            setHasMore(false);
            hasMoreRef.current = false;
            setHasLoadMoreError(true);
          }
        }
      } finally {
        if (activeFetchIdRef.current === fetchId) {
          if (isInitial) setIsLoading(false);
          else setIsLoadingMore(false);
          isFetchingRef.current = false;
        }
      }
    },
    [enabled, executeGraphQL, pageSize, stableInput],
  );

  const resetState = useCallback(() => {
    pageRef.current = 0;
    hasMoreRef.current = false;
    loadMoreFailCountRef.current = 0;
    setPlaylists([]);
    setTotalCount(0);
    setHasMore(false);
    setHasError(false);
    setHasLoadMoreError(false);
  }, []);

  useEffect(() => {
    resetState();
    if (!enabled) {
      // Orphan any in-flight request so it can't write into a disabled hook.
      activeFetchIdRef.current += 1;
      isFetchingRef.current = false;
      setIsLoading(false);
      setIsLoadingMore(false);
      return;
    }
    void fetchPage(0, true);
  }, [enabled, fetchPage, resetState]);

  const loadMore = useCallback(() => {
    if (isFetchingRef.current || !hasMoreRef.current) return;
    void fetchPage(pageRef.current, false);
  }, [fetchPage]);

  const retryLoadMore = useCallback(() => {
    if (isFetchingRef.current) return;
    loadMoreFailCountRef.current = 0;
    setHasLoadMoreError(false);
    setHasMore(true);
    hasMoreRef.current = true;
    void fetchPage(pageRef.current, false);
  }, [fetchPage]);

  const refetch = useCallback(() => {
    pageRef.current = 0;
    hasMoreRef.current = false;
    loadMoreFailCountRef.current = 0;
    setHasLoadMoreError(false);
    void fetchPage(0, true);
  }, [fetchPage]);

  return {
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
  };
}
