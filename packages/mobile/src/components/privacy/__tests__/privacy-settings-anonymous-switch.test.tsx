// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  offline: false,
  viewerId: 'viewer',
  credentialGeneration: 1,
  settings: {
    isPrivate: false,
    privacyRevision: 0,
    defaultSessionAudience: 'public',
    anonymousOnForeignBoards: false,
    enabled: false,
  },
  update: { mutate: vi.fn(), isPending: false, isError: false },
  anonymous: { mutate: vi.fn(), isPending: false, isError: false, variables: undefined as boolean | undefined },
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('react-native', () => ({
  View: ({ children }: { children: ReactNode }) => createElement('div', null, children),
  StyleSheet: { create: (styles: unknown) => styles },
}));
vi.mock('@shopify/flash-list', () => ({
  FlashList: ({ ListHeaderComponent }: { ListHeaderComponent: ReactNode }) =>
    createElement('div', null, ListHeaderComponent),
}));
vi.mock('expo-router', () => ({ router: { push: vi.fn(), back: vi.fn() } }));
vi.mock('../../Text', () => ({
  Text: ({ children }: { children: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../../Button', () => ({
  Button: ({ title, onPress, disabled }: { title: string; onPress?: () => void; disabled?: boolean }) =>
    createElement('button', { onClick: onPress, disabled }, title),
}));
vi.mock('../../ActivityIndicator', () => ({ ActivityIndicator: () => null }));
vi.mock('../AudiencePicker', () => ({
  AudiencePicker: ({ disabled }: { disabled?: boolean }) => createElement('button', { disabled }, 'session-audience'),
  SESSION_AUDIENCES: [],
}));
vi.mock('../../SwitchRow', () => ({
  SwitchRow: ({
    label,
    value,
    disabled,
    onValueChange,
  }: {
    label: string;
    value: boolean;
    disabled?: boolean;
    onValueChange: (next: boolean) => void;
  }) =>
    createElement(
      'button',
      { role: 'switch', disabled, 'aria-checked': value, onClick: () => onValueChange(!value) },
      label,
    ),
}));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    spacing: { 2: 8, 4: 16, 8: 32 },
    systemColors: { background: '#000' },
    brandColors: { error: '#f00', success: '#0f0' },
  }),
}));
vi.mock('../../../lib/auth-store', () => ({
  captureAuthCredentialGeneration: () => state.credentialGeneration,
  isAuthCredentialGenerationCurrent: (generation: number) => generation === state.credentialGeneration,
}));
vi.mock('../../../lib/connectivity/use-connectivity', () => ({
  useConnectivity: () => ({ effectiveOffline: state.offline }),
}));
vi.mock('../../../lib/graphql/hooks', () => ({
  useProfile: () => ({ data: { id: state.viewerId } }),
  useFollowers: () => ({ data: undefined, isError: false, isFetching: false }),
}));
vi.mock('../../../lib/graphql/hooks/use-privacy', () => ({
  PRIVACY_ONBOARDING_VERSION: 1,
  usePrivacySettings: () => ({ data: state.settings, isPending: false }),
  useUpdatePrivacySettings: () => state.update,
  useSetAnonymousOnForeignBoards: () => state.anonymous,
  useIncomingFollowRequests: () => ({ data: [], isError: false, isFetching: false }),
  usePrivacyFollowAction: () => ({ mutate: vi.fn(), isPending: false, isError: false }),
}));

import { PrivacySettingsScreen } from '../PrivacySettingsScreen';

const anonymousSwitch = () => screen.getByRole('switch', { name: 'privacy.anonymousOnForeignBoards' });

beforeEach(() => {
  state.offline = false;
  state.viewerId = 'viewer';
  state.credentialGeneration = 1;
  state.settings = { ...state.settings, anonymousOnForeignBoards: false, enabled: false };
  state.update = { mutate: vi.fn(), isPending: false, isError: false };
  state.anonymous = { mutate: vi.fn(), isPending: false, isError: false, variables: undefined };
});
afterEach(cleanup);

describe('Stay anonymous on boards I do not own', () => {
  it('shows and saves even while account privacy controls are off on the server', () => {
    render(createElement(PrivacySettingsScreen));
    // The controls that need the server flag stay hidden behind a one-line note.
    expect(screen.getByText('privacy.accountControlsLater')).toBeTruthy();
    expect(screen.queryByText('privacy.publicAccount')).toBeNull();
    expect(screen.queryByText('privacy.requests')).toBeNull();
    expect(anonymousSwitch().getAttribute('aria-checked')).toBe('false');
    fireEvent.click(anonymousSwitch());
    expect(state.anonymous.mutate).toHaveBeenCalledExactlyOnceWith(true);
  });

  it('shows the account controls, without the note, once the server has them', () => {
    state.settings = { ...state.settings, enabled: true };
    render(createElement(PrivacySettingsScreen));
    expect(screen.queryByText('privacy.accountControlsLater')).toBeNull();
    expect(screen.getByText('privacy.publicAccount')).toBeTruthy();
    expect(anonymousSwitch()).toBeTruthy();
  });

  it('reflects the saved choice and switches it back off', () => {
    state.settings = { ...state.settings, anonymousOnForeignBoards: true, enabled: true };
    render(createElement(PrivacySettingsScreen));
    expect(anonymousSwitch().getAttribute('aria-checked')).toBe('true');
    fireEvent.click(anonymousSwitch());
    expect(state.anonymous.mutate).toHaveBeenCalledExactlyOnceWith(false);
  });

  it('shows the pending choice while it saves, and blocks a second tap', () => {
    state.anonymous = { ...state.anonymous, isPending: true, variables: true };
    render(createElement(PrivacySettingsScreen));
    expect(anonymousSwitch().getAttribute('aria-checked')).toBe('true');
    expect((anonymousSwitch() as HTMLButtonElement).disabled).toBe(true);
  });

  it('blocks anonymity changes while an account save is pending', () => {
    state.settings = { ...state.settings, enabled: true };
    state.update.isPending = true;
    render(createElement(PrivacySettingsScreen));
    expect((anonymousSwitch() as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(anonymousSwitch());
    expect(state.anonymous.mutate).not.toHaveBeenCalled();
  });

  it('blocks account and session changes while the anonymity save is pending', () => {
    state.settings = { ...state.settings, enabled: true };
    state.anonymous.isPending = true;
    render(createElement(PrivacySettingsScreen));
    for (const name of ['privacy.publicAccount', 'privacy.privateAccount', 'privacy.save', 'session-audience']) {
      const control = screen.getByRole('button', { name }) as HTMLButtonElement;
      expect(control.disabled).toBe(true);
      fireEvent.click(control);
    }
    expect(state.update.mutate).not.toHaveBeenCalled();
  });

  it('ignores an old account save callback after the viewer changes', () => {
    state.settings = { ...state.settings, enabled: true };
    let finishSave!: () => void;
    state.update.mutate.mockImplementation((_input: unknown, callbacks: { onSuccess: () => void }) => {
      finishSave = callbacks.onSuccess;
    });
    const { rerender } = render(createElement(PrivacySettingsScreen));
    fireEvent.click(screen.getByRole('button', { name: 'privacy.privateAccount' }));
    fireEvent.click(screen.getByRole('button', { name: 'privacy.save' }));
    expect(state.update.mutate).toHaveBeenCalledTimes(1);
    state.viewerId = 'replacement-viewer';
    state.credentialGeneration += 1;
    rerender(createElement(PrivacySettingsScreen));
    act(() => finishSave());
    expect(screen.queryByText('privacy.saved')).toBeNull();
  });

  it('cannot change offline, and says so when a save fails', () => {
    state.offline = true;
    state.anonymous = { ...state.anonymous, isError: true };
    render(createElement(PrivacySettingsScreen));
    expect((anonymousSwitch() as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('privacy.saveFailed')).toBeTruthy();
  });
});
