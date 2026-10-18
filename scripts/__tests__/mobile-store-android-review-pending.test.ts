import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  checkReviewPending,
  reviewPendingDecision,
  reviewPendingOrFailOpen,
} from '../mobile-store-android-review-pending';

const release = (versionCode: number, state: string) => ({
  releaseLifecycleState: `RELEASE_LIFECYCLE_STATE_${state}`,
  activeArtifacts: [{ versionCode }],
});
afterEach(() => vi.unstubAllGlobals());

describe('Play review pre-check', () => {
  it.each(['production', 'beta'] as const)('holds the build while a %s release is in review', (track) => {
    const decision = reviewPendingDecision([
      { track: 'production', releases: [release(2001108, 'PUBLISHED')] },
      { track: 'beta', releases: [release(2001200, 'PUBLISHED')] },
      { track, releases: [release(2001310, 'IN_REVIEW')] },
    ]);
    expect(decision.pending).toBe(true);
    expect(decision.reason).toContain(`${track} (versionCode 2001310)`);
  });

  it.each(['DRAFT', 'NOT_SENT_FOR_REVIEW', 'APPROVED_NOT_PUBLISHED', 'PUBLISHED', 'NOT_APPROVED'])(
    'builds when the only other release is %s',
    (state) => {
      expect(
        reviewPendingDecision([
          { track: 'production', releases: [release(2001310, state)] },
          { track: 'beta', releases: [] },
        ]).pending,
      ).toBe(false);
    },
  );

  it('builds when both tracks are empty', () => {
    expect(
      reviewPendingDecision([
        { track: 'production', releases: [] },
        { track: 'beta', releases: [] },
      ]).pending,
    ).toBe(false);
  });

  it('reads only the non-edit production and beta summaries', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ releases: [release(2001108, 'PUBLISHED')] })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ releases: [release(2001310, 'IN_REVIEW')] })));
    vi.stubGlobal('fetch', fetchMock);
    expect(await checkReviewPending({ accessToken: 'secret' })).toMatchObject({ pending: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]![0]).toMatch(/\/tracks\/production\/releases$/);
    expect(fetchMock.mock.calls[1]![0]).toMatch(/\/tracks\/beta\/releases$/);
    for (const call of fetchMock.mock.calls) expect(call[1]!.method).toBe('GET');
  });

  it('treats an empty track (HTTP 204) as nothing pending', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(new Response(null, { status: 204 }))
        .mockResolvedValueOnce(new Response(null, { status: 204 })),
    );
    expect(await checkReviewPending({ accessToken: 'secret' })).toMatchObject({ pending: false });
  });

  // The upload keeps its own ERROR_IF_IN_REVIEW guard, so an unreadable Play
  // costs at most one wasted build; holding every build on an outage would not.
  it('fails open when Play cannot be read', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValueOnce(new Response('nope', { status: 500 })));
    const decision = await reviewPendingOrFailOpen(() => checkReviewPending({ accessToken: 'secret' }));
    expect(decision).toMatchObject({ pending: false, failedOpen: true });
    expect(decision.reason).toContain('HTTP 500');
    expect(decision.reason).not.toContain('nope');
  });

  it('passes a readable answer through unchanged', async () => {
    expect(await reviewPendingOrFailOpen(async () => ({ pending: true, reason: 'in review' }))).toEqual({
      pending: true,
      reason: 'in review',
      failedOpen: false,
    });
  });
});
