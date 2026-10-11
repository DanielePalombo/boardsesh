import type { DiscoverPlaylistsInput } from '@boardsesh/graphql/operations/playlists';

/**
 * The browse filters for the full Community Playlists list, as one object.
 *
 * Every field maps onto `discoverPlaylists` input in
 * `buildCommunityPlaylistsInput`; the screen only owns this object and never
 * builds server input itself. Adding a filter means: a field here, its default
 * in `DEFAULT_COMMUNITY_PLAYLIST_FILTERS`, its mapping in
 * `buildCommunityPlaylistsInput`, and (if it needs viewer data such as a follow
 * list) a field on `CommunityPlaylistsContext`.
 */
export type CommunityPlaylistFilters = {
  /** Free-text title search. Trimmed and capped before it reaches the server. */
  search: string;
  /** Whose playlists to show. */
  creator: CommunityPlaylistCreatorScope;
  sort: CommunityPlaylistSort;
  size: CommunityPlaylistSize;
};

/**
 * Whose playlists the list shows. `everyone` leaves the viewer's own out (they
 * have My Playlists for those); `mine` shows only the viewer's public ones.
 */
export type CommunityPlaylistCreatorScope = 'everyone' | 'mine';

/** `popular` matches the Discover shelf's default; `recent` is newest first. */
export type CommunityPlaylistSort = 'popular' | 'recent';

/** Climb-count bands. See `COMMUNITY_PLAYLIST_SIZE_BANDS` for the numbers. */
export type CommunityPlaylistSize = 'any' | 'short' | 'session' | 'big';

export const COMMUNITY_PLAYLIST_CREATOR_SCOPES: readonly CommunityPlaylistCreatorScope[] = ['everyone', 'mine'];
export const COMMUNITY_PLAYLIST_SORTS: readonly CommunityPlaylistSort[] = ['popular', 'recent'];
export const COMMUNITY_PLAYLIST_SIZES: readonly CommunityPlaylistSize[] = ['any', 'short', 'session', 'big'];

/** Inclusive climb-count bounds per size band. `any` sends no bound at all. */
export const COMMUNITY_PLAYLIST_SIZE_BANDS: Record<CommunityPlaylistSize, { minClimbs?: number; maxClimbs?: number }> =
  {
    any: {},
    short: { maxClimbs: 10 },
    session: { minClimbs: 11, maxClimbs: 30 },
    big: { minClimbs: 31 },
  };

export const DEFAULT_COMMUNITY_PLAYLIST_FILTERS: CommunityPlaylistFilters = {
  search: '',
  creator: 'everyone',
  sort: 'popular',
  size: 'any',
};

/** The server rejects a longer `name` (backend `DiscoverPlaylistsInputSchema`). */
export const COMMUNITY_PLAYLIST_SEARCH_MAX_LENGTH = 100;

/** Who is looking, and at which board. Not a filter the climber picks. */
export type CommunityPlaylistsContext = {
  /** The signed-in viewer's user id, or null when signed out. */
  viewerId: string | null;
  boardType?: string;
  layoutId?: number;
};

/** `discoverPlaylists` input for one filter state, without the page cursor. */
export type CommunityPlaylistsInput = Omit<DiscoverPlaylistsInput, 'page' | 'pageSize'>;

/**
 * The creator scope that actually applies. `mine` needs a viewer, so a
 * signed-out viewer (or one who signed out with `mine` picked) gets `everyone`.
 */
export function effectiveCommunityCreatorScope(
  filters: CommunityPlaylistFilters,
  context: Pick<CommunityPlaylistsContext, 'viewerId'>,
): CommunityPlaylistCreatorScope {
  if (filters.creator === 'mine' && !context.viewerId) return 'everyone';
  return filters.creator;
}

/** Maps the climber's filters onto `discoverPlaylists` input. Pure. */
export function buildCommunityPlaylistsInput(
  filters: CommunityPlaylistFilters,
  context: CommunityPlaylistsContext,
): CommunityPlaylistsInput {
  const input: CommunityPlaylistsInput = {
    // Community means climber-made: generated recommendation lists have their
    // own shelf, same as the Discover hub.
    generatedRecommendation: false,
    sortBy: filters.sort,
  };
  if (context.boardType !== undefined) input.boardType = context.boardType;
  if (context.layoutId !== undefined) input.layoutId = context.layoutId;

  const search = filters.search.trim().slice(0, COMMUNITY_PLAYLIST_SEARCH_MAX_LENGTH);
  if (search.length > 0) input.name = search;

  const scope = effectiveCommunityCreatorScope(filters, context);
  if (scope === 'mine' && context.viewerId) {
    input.creatorIds = [context.viewerId];
  } else if (scope === 'everyone' && context.viewerId) {
    input.excludeCreatorIds = [context.viewerId];
  }

  const band = COMMUNITY_PLAYLIST_SIZE_BANDS[filters.size];
  if (band.minClimbs !== undefined) input.minClimbs = band.minClimbs;
  if (band.maxClimbs !== undefined) input.maxClimbs = band.maxClimbs;

  return input;
}

/**
 * True when the filters narrow the list beyond the defaults, ignoring sort
 * (a sort never hides a playlist). Drives the "Clear filters" action.
 */
export function hasActiveCommunityPlaylistFilters(filters: CommunityPlaylistFilters): boolean {
  return (
    filters.search.trim().length > 0 ||
    filters.creator !== DEFAULT_COMMUNITY_PLAYLIST_FILTERS.creator ||
    filters.size !== DEFAULT_COMMUNITY_PLAYLIST_FILTERS.size
  );
}

/**
 * Resets everything that narrows the list and keeps the chosen sort, so
 * "Clear filters" doesn't also flip the order the climber picked.
 */
export function clearCommunityPlaylistFilters(filters: CommunityPlaylistFilters): CommunityPlaylistFilters {
  return { ...DEFAULT_COMMUNITY_PLAYLIST_FILTERS, sort: filters.sort };
}
