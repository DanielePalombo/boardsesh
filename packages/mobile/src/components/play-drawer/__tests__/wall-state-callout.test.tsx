// @vitest-environment jsdom
vi.mock('../../AccessibleTextInput', async () => {
  const { TextInput } = await import('react-native');
  return { AccessibleTextInput: TextInput };
});
vi.mock('../../../hooks/use-bold-text', () => ({ useBoldText: () => false }));
vi.mock('../../PressableSurface', async () => {
  const { Pressable } = await import('react-native');
  const { createElement } = await import('react');
  return {
    PressableSurface: (props: React.ComponentProps<typeof Pressable>) =>
      createElement(Pressable, { ...props, onPress: props.disabled ? undefined : props.onPress }),
  };
});
// The explainer is the ungated way out of a browse latch — it sits in the header,
// outside the region the switch-board overlay scrims — so the assertions here are
// about which actions it offers in which state, and that it can always be closed.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render } from '@testing-library/react';
import { createElement, forwardRef, type ReactNode } from 'react';

const routerPush = vi.hoisted(() => vi.fn());
const backHandler = vi.hoisted(() => ({
  handler: null as null | (() => boolean),
  remove: vi.fn(),
}));
const setAccessibilityFocus = vi.hoisted(() => vi.fn());
// Flips the react-native mock (and the accessibility-focus hook) into the
// react-native-web shape for the "#5301 on web" describe block below, without
// needing a separate copy of every other mock in this file.
const wallStateCalloutPlatform = vi.hoisted(() => ({ web: false }));

type ViewMockProps = { children?: ReactNode; style?: unknown; accessibilityViewIsModal?: boolean };
type PressMockProps = {
  children?: ReactNode;
  onPress?: () => void;
  disabled?: boolean;
  accessibilityLabel?: string;
};

vi.mock('react-native', () => ({
  // Forwards the ref like the real View does, so bodyRef.current in the
  // component under test is the actual DOM node the focus hook operates on.
  View: forwardRef<HTMLDivElement, ViewMockProps>(({ children, accessibilityViewIsModal }, ref) =>
    createElement('div', { ref, 'data-modal': accessibilityViewIsModal ? 'true' : '' }, children),
  ),
  Pressable: ({ children, onPress, disabled, accessibilityLabel }: PressMockProps) =>
    createElement('button', { onClick: onPress, disabled, 'data-label': accessibilityLabel ?? '' }, children),
  StyleSheet: {
    flatten: (style: unknown) => Object.assign({}, ...[style].flat(10).filter(Boolean)),
    create: (styles: Record<string, unknown>) => styles,
    hairlineWidth: 1,
    absoluteFill: {},
  },
  BackHandler: {
    addEventListener: (_event: string, handler: () => boolean) => {
      backHandler.handler = handler;
      return { remove: backHandler.remove };
    },
  },
  AccessibilityInfo: { setAccessibilityFocus },
  // react-native-web 0.21.2's findNodeHandle is a bare, unconditional throw —
  // see the "#5301 on web" describe block. Otherwise a real node handle, so
  // the focus call isn't skipped by the null guard.
  findNodeHandle: () => {
    if (wallStateCalloutPlatform.web) {
      throw new Error('findNodeHandle is not supported on web. Use the ref property on the component instead.');
    }
    return 7;
  },
}));

// Routes the accessibility-focus effect to the same fork Metro would pick for
// the current platform, so the "#5301 on web" tests below exercise the real
// use-announce-body-focus.web.ts implementation instead of the native one.
vi.mock('../use-announce-body-focus', async () => {
  const native = await vi.importActual<typeof import('../use-announce-body-focus')>('../use-announce-body-focus');
  const web = await vi.importActual<typeof import('../use-announce-body-focus.web')>('../use-announce-body-focus.web');
  return {
    useAnnounceBodyFocus: (
      bodyRef: Parameters<typeof native.useAnnounceBodyFocus>[0],
      enabled: Parameters<typeof native.useAnnounceBodyFocus>[1],
    ) =>
      wallStateCalloutPlatform.web
        ? web.useAnnounceBodyFocus(bodyRef, enabled)
        : native.useAnnounceBodyFocus(bodyRef, enabled),
  };
});

vi.mock('react-native-reanimated', () => {
  const settleBuilder: Record<string, unknown> = {};
  Object.assign(settleBuilder, {
    damping: () => settleBuilder,
    stiffness: () => settleBuilder,
    mass: () => settleBuilder,
    withInitialValues: (values: unknown) => ({ settle: values }),
  });
  return {
    default: {
      // Passes the live region through: the card must not carry one — focus
      // lands on the body when it opens, and a region would read it twice.
      View: ({ children, accessibilityLiveRegion }: ViewMockProps & { accessibilityLiveRegion?: string }) =>
        createElement('div', { 'data-live-region': accessibilityLiveRegion ?? '' }, children),
    },
    FadeIn: { duration: (ms: number) => ({ fadeIn: ms, easing: (curve: unknown) => ({ fadeIn: ms, easing: curve }) }) },
    FadeInUp: { springify: () => settleBuilder },
    useReducedMotion: () => false,
  };
});

vi.mock('../../../theme/animations', () => ({ springs: { gentle: { damping: 15, stiffness: 150, mass: 1 } } }));
vi.mock('../../../theme/motion-config', () => ({ timingFor: (config: { duration: number }) => config }));

vi.mock('expo-router', () => ({ router: { push: routerPush }, useRouter: () => ({ push: routerPush }) }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../../board-presence/BoardDriverAvatar', () => ({
  BoardDriverAvatar: ({ name }: { name?: string | null }) =>
    createElement('div', { 'data-driver-avatar': 'true', 'data-name': name ?? '' }),
}));

const driverState = vi.hoisted(() => ({
  value: {
    driver: null as { userId: string | null; avatarUrl: string | null } | null,
    name: null as string | null,
    litAgo: null as string | null,
  },
}));
vi.mock('../use-wall-driver', () => ({ useWallDriver: () => driverState.value }));

vi.mock('../../../providers/theme-provider', () => ({
  useOptionalTheme: () => null,
  useTheme: () => ({
    variant: 'liquidGlass',
    systemColors: { elevatedSurface: '#FFF', separator: '#CCC', label: '#111', secondaryLabel: '#666' },
    brandColors: { tint: '#6D28D9' },
    m3: {},
    m3SurfaceContainers: { high: '#EEE' },
    materialElevation: { level2: { elevation: 2 } },
    motion: { standard: { duration: 200 } },
  }),
}));
vi.mock('../../../theme/tokens', () => ({
  opacity: { disabled: 0.5 },
  spacing: { 1: 4, 2: 8, 3: 12, 4: 16 },
  borderRadius: { lg: 12 },
  shadows: { md: { shadowRadius: 4 } },
}));
vi.mock('../../../theme/layout', () => ({ glassSize: { inline: 44 } }));

import { WallStateCallout } from '../WallStateCallout';

const renderCallout = (props: Partial<Parameters<typeof WallStateCallout>[0]> = {}) =>
  render(
    createElement(WallStateCallout, {
      state: 'browsing' as const,
      top: 120,
      onDismiss: vi.fn(),
      ...props,
    }),
  );

const labels = (container: HTMLElement) =>
  [...container.querySelectorAll('button')].map((node) => node.getAttribute('data-label') ?? '');

beforeEach(() => {
  routerPush.mockClear();
  backHandler.handler = null;
  backHandler.remove.mockClear();
  setAccessibilityFocus.mockClear();
  driverState.value = { driver: null, name: null, litAgo: null };
});

describe('WallStateCallout', () => {
  it('explains the state in one line', () => {
    expect(renderCallout({ state: 'browsing' }).container.textContent).toContain('playView.wallState.browsingHint');
    expect(renderCallout({ state: 'live' }).container.textContent).toContain('playView.wallState.liveHint');
    expect(renderCallout({ state: 'onWall' }).container.textContent).toContain('playView.wallState.onWallHint');
  });

  it('offers Back to live only when a latch is actually up', () => {
    const withLatch = renderCallout({ onBackToLive: vi.fn() });
    expect(withLatch.container.textContent).toContain('playView.wallState.backToLive');

    const withoutLatch = renderCallout();
    expect(withoutLatch.container.textContent).not.toContain('playView.wallState.backToLive');
  });

  it('makes Back to live its one action, and runs the host handler from it', () => {
    const onBackToLive = vi.fn();
    const onDismiss = vi.fn();
    const { container } = renderCallout({ state: 'live', onBackToLive, onDismiss });

    // Browse from here is gone: a crew browses by default, and the browsing pill
    // itself is the way back, so the explainer offers only the exit.
    expect(container.textContent).not.toContain('playView.wallState.browseFromHere');
    const actionButtons = [...container.querySelectorAll('button')].filter(
      (node) => node.getAttribute('data-label') !== 'playView.closeAria',
    );
    expect(actionButtons.map((node) => node.textContent)).toEqual(['playView.wallState.backToLive']);

    actionButtons[0]?.click();
    expect(onBackToLive).toHaveBeenCalledTimes(1);
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('carries the driver row on the wall — the profile tap the pill gave up', () => {
    driverState.value = { driver: { userId: 'u1', avatarUrl: null }, name: 'Marco', litAgo: '5m' };
    const { container } = renderCallout({ state: 'onWall' });

    expect(container.querySelector('[data-driver-avatar="true"]')?.getAttribute('data-name')).toBe('Marco');
    expect(container.textContent).toContain('5m');

    const driverRow = container.querySelector('[data-label="mobile.boardPresence.drivenByA11y"]') as HTMLButtonElement;
    driverRow.click();
    expect(routerPush).toHaveBeenCalledWith({ pathname: '/users/[userId]', params: { userId: 'u1' } });
  });

  it('leaves an anonymous driver row inert instead of routing nowhere', () => {
    driverState.value = { driver: { userId: null, avatarUrl: null }, name: null, litAgo: null };
    const { container } = renderCallout({ state: 'onWall' });

    const driverRow = container.querySelector(
      '[data-label="mobile.boardPresence.drivenByAnonA11y"]',
    ) as HTMLButtonElement;
    expect(driverRow.disabled).toBe(true);
    driverRow.click();
    expect(routerPush).not.toHaveBeenCalled();
  });

  it('dismisses on an outside tap', () => {
    const onDismiss = vi.fn();
    const { container } = renderCallout({ onDismiss });

    // The scrim is the first button in the tree, and it is LABELLED rather than
    // decorative so assistive tech has a way out too.
    const scrim = container.querySelector('button') as HTMLButtonElement;
    expect(labels(container)[0]).toBe('playView.closeAria');
    scrim.click();
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  // The `live` state with no preview pinned offers no action at all (no latch
  // to leave), so the labelled scrim IS the only way out —
  // which only works if it sits INSIDE the region claiming the modal. Put
  // `accessibilityViewIsModal` on the card alone and iOS VoiceOver hides its
  // siblings, scrim included, and traps the reader until the 8s timeout.
  it('keeps the scrim inside the modal region, so there is always a way out', () => {
    const { container } = renderCallout({ state: 'live' });

    const modalRegion = container.querySelector('div[data-modal="true"]') as HTMLElement;
    expect(modalRegion).toBeTruthy();
    expect(modalRegion.querySelector('button[data-label="playView.closeAria"]')).toBeTruthy();
    // Nothing else is actionable in this state — hence the assertion above.
    expect(labels(container)).toEqual(['playView.closeAria']);
  });

  it('lands the screen reader on the sentence the climber asked for', () => {
    renderCallout({ state: 'browsing' });

    expect(setAccessibilityFocus).toHaveBeenCalledWith(7);
  });

  it('dismisses on Android hardware back instead of closing the whole player', () => {
    const onDismiss = vi.fn();
    const { unmount } = renderCallout({ onDismiss });

    expect(backHandler.handler).not.toBeNull();
    // Returning true is what stops the event bubbling to the modal route.
    expect(backHandler.handler?.()).toBe(true);
    expect(onDismiss).toHaveBeenCalledTimes(1);

    unmount();
    expect(backHandler.remove).toHaveBeenCalled();
  });

  it('stands down on its own if left alone — it is an explainer, not a decision', () => {
    vi.useFakeTimers();
    try {
      const onDismiss = vi.fn();
      renderCallout({ onDismiss });

      vi.advanceTimersByTime(7999);
      expect(onDismiss).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(onDismiss).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

// The one-shot "you're browsing now" card is gone: the host only speaks that
// sentence now, and Put on the wall plus the back chip are the visible half. So
// every time this card shows, the climber asked for it.
describe('WallStateCallout — always the tapped explainer', () => {
  it.each(['onWall', 'live', 'browsing'] as const)(
    'never carries the joined-a-crew notice on %s, and claims the modal it was asked for',
    (state) => {
      const { container } = renderCallout({ state });

      expect(container.textContent).not.toContain('playView.wallState.joinedBrowseNotice');
      expect(container.querySelector('div[data-modal="true"]')).toBeTruthy();
      expect(labels(container)[0]).toBe('playView.closeAria');
      expect(backHandler.handler).not.toBeNull();
    },
  );

  it('carries no live region: focus moving onto the body reads it once', () => {
    const { container } = renderCallout({ state: 'browsing' });

    expect(container.querySelector('[data-live-region="polite"]')).toBeNull();
    expect(container.querySelector('[data-live-region="none"]')).toBeTruthy();
    expect(setAccessibilityFocus).toHaveBeenCalledTimes(1);
  });
});

// #5301: on app.boardsesh.com, tapping the wall-state pill mounted this card,
// its mount effect called findNodeHandle, react-native-web's findNodeHandle is
// an unconditional throw, and the root error boundary replaced the whole app
// with the crash screen. 100% failure rate — it never once worked in a
// browser. These tests run the SAME component tree through the mocked web
// runtime (see wallStateCalloutPlatform above) to prove that no longer happens.
describe('WallStateCallout on web (#5301)', () => {
  beforeEach(() => {
    wallStateCalloutPlatform.web = true;
  });

  afterEach(() => {
    wallStateCalloutPlatform.web = false;
  });

  it('does not throw when the accessibility-focus effect runs', () => {
    expect(() => renderCallout({ state: 'browsing' })).not.toThrow();
  });

  it('still renders the explainer sentence and actions', () => {
    const { container } = renderCallout({ state: 'browsing', onBackToLive: vi.fn() });
    expect(container.textContent).toContain('playView.wallState.browsingHint');
    expect(container.textContent).toContain('playView.wallState.backToLive');
  });

  it('lands DOM focus on the body sentence instead of using AccessibilityInfo', () => {
    const { container } = renderCallout({ state: 'browsing' });
    // modalRegion div > card div (Animated.View) > body div (the ref target).
    const body = container.querySelector('div[data-modal="true"] > div:nth-child(2) > div:first-child');
    expect(body).not.toBeNull();
    expect(document.activeElement).toBe(body);
    // The native-only API is never reached on the web fork.
    expect(setAccessibilityFocus).not.toHaveBeenCalled();
  });
});

afterEach(() => {
  vi.useRealTimers();
});
