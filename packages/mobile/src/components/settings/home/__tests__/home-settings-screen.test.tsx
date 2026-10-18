// @vitest-environment jsdom
import { createElement, useSyncExternalStore } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import type { MoreButtonRow, MoreFormModel, MoreSegmentedRow, MoreToggleRow } from '../../../MoreForm.types';
import type { SettingsChange } from '../../../../settings/hooks';

// The real controls and store behind the native form; only the form, the
// reporting and the settings file are stand-ins.
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
vi.mock('../../../../lib/analytics', () => ({ track: analytics.track }));
vi.mock('../../../../lib/haptics', () => ({ hapticSelection: vi.fn() }));
const settingsFile = vi.hoisted(() => ({
  subscribe: (listener: (change: SettingsChange) => void) => {
    settings.listeners.add(listener);
    return () => {
      settings.listeners.delete(listener);
    };
  },
  get: (key: string) => settings.values.get(key) ?? null,
  set: (key: string, value: unknown) => {
    settings.values.set(key, value);
    for (const listener of settings.listeners) listener({ kind: 'setting', key: key as never });
  },
}));
vi.mock('../../../../settings/hooks', () => ({
  subscribeSettings: settingsFile.subscribe,
  getSetting: settingsFile.get,
  setSetting: settingsFile.set,
}));
vi.mock('../../../../settings', () => ({
  useSetting: (key: string) => {
    const value = useSyncExternalStore(settingsFile.subscribe, () => settingsFile.get(key));
    return [value, (next: unknown) => settingsFile.set(key, next)];
  },
}));

import { HomeSettingsScreen } from '../HomeSettingsScreen';
import { homeSectionsStore } from '../../../../lib/home-sections';

function rows() {
  return captured.model?.sections.flatMap((section) => section.rows) ?? [];
}
function toggle(key: string): MoreToggleRow {
  const row = rows().find((candidate) => candidate.key === key);
  if (row?.kind !== 'toggle') throw new Error(`no toggle ${key}`);
  return row;
}
function segmented(key: string): MoreSegmentedRow {
  const row = rows().find((candidate) => candidate.key === key);
  if (row?.kind !== 'segmented') throw new Error(`no segmented row ${key}`);
  return row;
}
function button(key: string): MoreButtonRow {
  const row = rows().find((candidate) => candidate.key === key);
  if (row?.kind !== 'button') throw new Error(`no button ${key}`);
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

describe('HomeSettingsScreen', () => {
  it('lists a switch per section in the saved order, then the presets', () => {
    homeSectionsStore.move('climbingNow', -1);
    render(createElement(HomeSettingsScreen));
    expect(captured.model?.sections.map((section) => section.key)).toEqual(['startup', 'sections', 'presets']);
    expect(captured.model?.sections[1].rows.map((row) => row.key)).toEqual([
      'board',
      'session',
      'climbingNow',
      'playlists',
      'beta',
      'feed',
    ]);
    expect(captured.model?.sections[2].rows.map((row) => row.key)).toEqual(['showAll', 'focused', 'restoreDefaults']);
  });

  it('reports a switch once, under the Home page', () => {
    render(createElement(HomeSettingsScreen));
    act(() => toggle('beta').onValueChange(true));
    expect(settingChangedCalls()).toEqual([{ page: 'homeScreen', key: 'beta', value: true }]);
    expect(homeSectionsStore.getLayout().visible.beta).toBe(true);
    expect(toggle('beta').value).toBe(true);
  });

  it('offers Focused and Restore defaults only when they would change something', () => {
    render(createElement(HomeSettingsScreen));
    expect(button('restoreDefaults').disabled).toBe(true);
    act(() => button('focused').onPress());
    expect(button('focused').disabled).toBe(true);
    expect(button('restoreDefaults').disabled).toBe(false);
    expect(toggle('feed').value).toBe(false);
    act(() => button('restoreDefaults').onPress());
    expect(toggle('feed').value).toBe(true);
    expect(settings.values.get('homeSectionsV1')).toBeNull();
  });

  it('shows Climbs for an unknown stored start-up tab, and saves a new one once, reporting it once', () => {
    settings.values.set('startupScreen', 'profile');
    render(createElement(HomeSettingsScreen));
    expect(segmented('startupScreen').selectedKey).toBe('climbs');
    act(() => segmented('startupScreen').onSelect('home'));
    expect(settings.values.get('startupScreen')).toBe('home');
    expect(segmented('startupScreen').selectedKey).toBe('home');
    act(() => segmented('startupScreen').onSelect('home'));
    expect(settingChangedCalls()).toEqual([{ page: 'homeScreen', key: 'startupScreen', value: 'home' }]);
  });
});
