import { describe, it, expect } from 'vitest';
import {
  buildCommunityPlaylistsInput,
  clearCommunityPlaylistFilters,
  effectiveCommunityCreatorScope,
  hasActiveCommunityPlaylistFilters,
  COMMUNITY_PLAYLIST_SEARCH_MAX_LENGTH,
  DEFAULT_COMMUNITY_PLAYLIST_FILTERS,
  type CommunityPlaylistFilters,
} from '../community-playlist-filters';

const VIEWER = 'user-1';
const BOARD = { boardType: 'kilter', layoutId: 8 };

function filtersWith(overrides: Partial<CommunityPlaylistFilters>): CommunityPlaylistFilters {
  return { ...DEFAULT_COMMUNITY_PLAYLIST_FILTERS, ...overrides };
}

describe('buildCommunityPlaylistsInput', () => {
  it('maps the defaults to a popular, climber-made list without the viewer', () => {
    expect(buildCommunityPlaylistsInput(DEFAULT_COMMUNITY_PLAYLIST_FILTERS, { viewerId: VIEWER, ...BOARD })).toEqual({
      boardType: 'kilter',
      layoutId: 8,
      generatedRecommendation: false,
      sortBy: 'popular',
      excludeCreatorIds: [VIEWER],
    });
  });

  it('sends no creator filter for a signed-out viewer', () => {
    const input = buildCommunityPlaylistsInput(DEFAULT_COMMUNITY_PLAYLIST_FILTERS, { viewerId: null });
    expect(input).toEqual({ generatedRecommendation: false, sortBy: 'popular' });
  });

  it('scopes to the viewer for "mine"', () => {
    const input = buildCommunityPlaylistsInput(filtersWith({ creator: 'mine' }), { viewerId: VIEWER });
    expect(input.creatorIds).toEqual([VIEWER]);
    expect(input.excludeCreatorIds).toBeUndefined();
  });

  it('falls back to everyone when "mine" is picked but nobody is signed in', () => {
    const input = buildCommunityPlaylistsInput(filtersWith({ creator: 'mine' }), { viewerId: null });
    expect(input.creatorIds).toBeUndefined();
    expect(input.excludeCreatorIds).toBeUndefined();
  });

  it('maps the sort straight through', () => {
    expect(buildCommunityPlaylistsInput(filtersWith({ sort: 'recent' }), { viewerId: null }).sortBy).toBe('recent');
  });

  it('trims the search, drops it when blank, and caps it at the server limit', () => {
    expect(buildCommunityPlaylistsInput(filtersWith({ search: '  crimps ' }), { viewerId: null }).name).toBe('crimps');
    expect(buildCommunityPlaylistsInput(filtersWith({ search: '   ' }), { viewerId: null })).not.toHaveProperty('name');
    const long = 'a'.repeat(COMMUNITY_PLAYLIST_SEARCH_MAX_LENGTH + 20);
    expect(buildCommunityPlaylistsInput(filtersWith({ search: long }), { viewerId: null }).name).toHaveLength(
      COMMUNITY_PLAYLIST_SEARCH_MAX_LENGTH,
    );
  });

  it.each([
    ['any', undefined, undefined],
    ['short', undefined, 10],
    ['session', 11, 30],
    ['big', 31, undefined],
  ] as const)('maps size %s to minClimbs %s / maxClimbs %s', (size, minClimbs, maxClimbs) => {
    const input = buildCommunityPlaylistsInput(filtersWith({ size }), { viewerId: null });
    expect(input.minClimbs).toBe(minClimbs);
    expect(input.maxClimbs).toBe(maxClimbs);
    if (minClimbs === undefined) expect(input).not.toHaveProperty('minClimbs');
    if (maxClimbs === undefined) expect(input).not.toHaveProperty('maxClimbs');
  });

  it('leaves out board fields the context does not carry', () => {
    const input = buildCommunityPlaylistsInput(DEFAULT_COMMUNITY_PLAYLIST_FILTERS, { viewerId: null });
    expect(input).not.toHaveProperty('boardType');
    expect(input).not.toHaveProperty('layoutId');
  });
});

describe('effectiveCommunityCreatorScope', () => {
  it('keeps "mine" only with a viewer', () => {
    expect(effectiveCommunityCreatorScope(filtersWith({ creator: 'mine' }), { viewerId: VIEWER })).toBe('mine');
    expect(effectiveCommunityCreatorScope(filtersWith({ creator: 'mine' }), { viewerId: null })).toBe('everyone');
  });
});

describe('hasActiveCommunityPlaylistFilters / clearCommunityPlaylistFilters', () => {
  it('is false for the defaults and for a sort change alone', () => {
    expect(hasActiveCommunityPlaylistFilters(DEFAULT_COMMUNITY_PLAYLIST_FILTERS)).toBe(false);
    expect(hasActiveCommunityPlaylistFilters(filtersWith({ sort: 'recent' }))).toBe(false);
    expect(hasActiveCommunityPlaylistFilters(filtersWith({ search: '  ' }))).toBe(false);
  });

  it('is true for a search, a creator scope, or a size band', () => {
    expect(hasActiveCommunityPlaylistFilters(filtersWith({ search: 'crimps' }))).toBe(true);
    expect(hasActiveCommunityPlaylistFilters(filtersWith({ creator: 'mine' }))).toBe(true);
    expect(hasActiveCommunityPlaylistFilters(filtersWith({ size: 'big' }))).toBe(true);
  });

  it('clears everything that narrows the list but keeps the sort', () => {
    const cleared = clearCommunityPlaylistFilters({ search: 'crimps', creator: 'mine', sort: 'recent', size: 'short' });
    expect(cleared).toEqual({ ...DEFAULT_COMMUNITY_PLAYLIST_FILTERS, sort: 'recent' });
    expect(hasActiveCommunityPlaylistFilters(cleared)).toBe(false);
  });
});
