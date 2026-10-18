// @vitest-environment jsdom
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import type { MoreFormModel, MoreToggleRow } from '../../../MoreForm.types';
import type { SettingsChange } from '../../../../settings/hooks';

// The screen's own hooks are stubs; the Home switches, the tracking wrapper and
// the store behind them are real, so this pins how many `Setting Changed`
// events one tap sends.
const captured = vi.hoisted(() => ({ model: null as MoreFormModel | null }));
const analytics = vi.hoisted(() => ({ track: vi.fn() }));
const settings = vi.hoisted(() => ({
  listeners: new Set<(change: SettingsChange) => void>(),
  values: new Map<string, unknown>(),
}));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../../MoreForm', () => ({
  MoreForm: ({ model }: { model: MoreFormModel }) => {
    captured.model = model;
    return null;
  },
}));
vi.mock('../../../offline-mode-row', () => ({ buildOfflineModeRow: () => null }));
vi.mock('../../../../lib/routing/scoped-navigation', () => ({ scopedRouter: { push: vi.fn() } }));
vi.mock('../../../../db/use-offline-database', () => ({ useOfflineDatabase: () => null }));
vi.mock('../../../../db/use-offline-schema-ready', () => ({ useOfflineSchemaReady: () => false }));
vi.mock('../../../../providers/theme-provider', () => ({
  useTheme: () => ({ themeOverride: 'system', setThemeOverride: vi.fn() }),
}));
vi.mock('../../../../providers/i18n-provider', () => ({
  useLocalePreference: () => ({ localePreference: 'system', setLocalePreference: vi.fn() }),
}));
vi.mock('../../../../providers/toast-provider', () => ({ useToast: () => ({ showToast: vi.fn() }) }));
vi.mock('../../../../providers/feature-flags-provider', () => ({ useOfflineDownloadsEnabled: () => true }));
vi.mock('../../../../lib/analytics', () => ({ track: analytics.track }));
vi.mock('../../../../lib/connectivity/use-connectivity', () => ({
  useConnectivity: () => ({ effectiveOffline: false, offlineMode: false }),
}));
vi.mock('../../../../lib/connectivity/connectivity-store', () => ({ isOfflineModeSupported: () => false }));
vi.mock('../../../../lib/i18n/locale-preference', () => ({ resolveLanguage: () => 'en-US' }));
vi.mock('../../../../lib/open-url', () => ({ openExternalUrl: vi.fn() }));
vi.mock('../../../../lib/haptics', () => ({ hapticLight: vi.fn(), hapticSelection: vi.fn() }));
vi.mock('../../../../lib/error-reporting', () => ({ reportError: vi.fn() }));
vi.mock('../../../../lib/offline-engine', () => ({ isOfflineEngineEnabled: () => false }));
vi.mock('../../../../lib/onboarding/onboarding-storage', () => ({ replayOnboarding: vi.fn() }));
vi.mock('../../../../lib/board-render/replay-board-look-step', () => ({ replayBoardLookStep: vi.fn() }));
vi.mock('../../../../offline/outbox-store', () => ({ useOutboxSummary: () => null }));
vi.mock('../../../../offline/use-keep-boards-offline', () => ({ useMissingOfflineBoards: () => () => [] }));
vi.mock('../../../../settings', () => ({
  forgetDownloadAllTap: vi.fn(),
  rememberDownloadAllTap: vi.fn(),
  setSetting: vi.fn(),
  useSetting: () => [false, vi.fn()],
}));
vi.mock('../../../../settings/hooks', () => ({
  subscribeSettings: (listener: (change: SettingsChange) => void) => {
    settings.listeners.add(listener);
    return () => settings.listeners.delete(listener);
  },
  getSetting: (key: string) => settings.values.get(key) ?? null,
  setSetting: (key: string, value: unknown) => {
    settings.values.set(key, value);
    for (const listener of settings.listeners) listener({ kind: 'setting', key: key as never });
  },
}));
vi.mock('../../offline/auto-offline-boards-toggle', () => ({
  makeAutoOfflineBoardsToggle: () => vi.fn(),
}));
vi.mock('../../offline/use-show-storage', () => ({ useShowStorage: () => false }));

import { GeneralSettingsScreen } from '../GeneralSettingsScreen';
import { homeSectionsStore } from '../../../../lib/home-sections';

function toggle(key: string): MoreToggleRow {
  const row = captured.model?.sections.flatMap((section) => section.rows).find((candidate) => candidate.key === key);
  if (row?.kind !== 'toggle') throw new Error(`no toggle ${key}`);
  return row;
}

function settingChangedCalls() {
  return analytics.track.mock.calls
    .filter(([event]) => event === 'Setting Changed')
    .map(([, properties]) => properties);
}

beforeEach(() => {
  settings.values.clear();
  homeSectionsStore.restoreDefaults();
  analytics.track.mockClear();
  captured.model = null;
});

afterEach(() => {
  cleanup();
});

describe('GeneralSettingsScreen', () => {
  it('reports a Home switch once, under the Home page, not twice', () => {
    render(createElement(GeneralSettingsScreen));
    act(() => toggle('homeSection.board').onValueChange(true));
    expect(settingChangedCalls()).toEqual([{ page: 'homeScreen', key: 'board', value: true }]);
    expect(homeSectionsStore.getLayout().visible.board).toBe(true);
    expect(toggle('homeSection.board').value).toBe(true);
  });

  it("still reports General's own switches under General", () => {
    render(createElement(GeneralSettingsScreen));
    act(() => toggle('autoOfflineBoards').onValueChange(true));
    expect(settingChangedCalls()).toEqual([{ page: 'general', key: 'autoOfflineBoards', value: true }]);
  });
});
