// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MoreFormModel } from '../MoreForm.types';

// MoreForm.android require()s Android vector-drawable .xml assets, which Metro
// treats as assets; node cannot parse them, so stub the extension to a number.
vi.hoisted(() => {
  // oxlint-disable-next-line no-require-imports
  const nodeModule = require('node:module') as { _extensions: Record<string, (target: { exports: unknown }) => void> };
  nodeModule._extensions['.xml'] = (target) => {
    target.exports = 1;
  };
});

vi.mock('@expo/ui', () => ({
  Host: ({ children }: { children?: ReactNode }) => createElement('div', { 'data-testid': 'compose-host' }, children),
}));
vi.mock('@expo/ui/jetpack-compose', () => {
  const Container = ({ children }: { children?: ReactNode }) => createElement('div', null, children);
  const WithSlots = Object.assign(Container, {
    Trigger: Container,
    Items: Container,
    LeadingIcon: Container,
    Text: Container,
  });
  return {
    LazyColumn: Container,
    Card: Container,
    Column: Container,
    Row: Container,
    Text: Container,
    Switch: Container,
    Button: Container,
    TextButton: Container,
    Badge: Container,
    Icon: Container,
    IconButton: Container,
    Spacer: Container,
    SingleChoiceSegmentedButtonRow: Container,
    SegmentedButton: Container,
    DropdownMenu: WithSlots,
    DropdownMenuItem: WithSlots,
    BasicTextField: Container,
    Slider: Container,
    CircularProgressIndicator: Container,
    useNativeState: (initial: unknown) => ({ value: initial }),
  };
});
vi.mock('@expo/ui/jetpack-compose/modifiers', () => {
  const modifier = () => ({});
  return {
    fillMaxWidth: modifier,
    padding: modifier,
    alpha: modifier,
    weight: modifier,
    clickable: modifier,
    size: modifier,
    semantics: modifier,
  };
});
vi.mock('react-native', () => ({
  Platform: { OS: 'android', select: (options: { android?: unknown }) => options.android },
  PlatformColor: (name: string) => name,
  StyleSheet: { create: (styles: unknown) => styles },
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../providers/theme-provider', async () => {
  const { makeThemeMock } = await import('../../test/theme-mock');
  const theme = makeThemeMock({ variant: 'material' });
  return { useTheme: () => theme };
});
vi.mock('../MoreForm.rn', () => ({
  MoreFormRN: ({ model }: { model: MoreFormModel }) =>
    createElement('div', { 'data-testid': 'rn-form' }, String(model.sections.length)),
}));

import { MoreForm } from '../MoreForm.android';
import { modelHasCustomRow } from '../MoreForm.logic';

const customModel: MoreFormModel = {
  sections: [
    { key: 'first', rows: [{ kind: 'value', key: 'v', label: 'Label', value: 'x' }] },
    {
      key: 'second',
      rows: [{ kind: 'custom', key: 'preview', content: createElement('span', null, 'Preview'), height: 120 }],
    },
  ],
};
const plainModel: MoreFormModel = {
  sections: [{ key: 'only', rows: [{ kind: 'value', key: 'v', label: 'Label', value: 'x' }] }],
};

afterEach(cleanup);

describe('MoreForm on Android with custom rows', () => {
  it('detects a custom row in any section', () => {
    expect(modelHasCustomRow(customModel)).toBe(true);
    expect(modelHasCustomRow(plainModel)).toBe(false);
  });

  it('renders a model with a custom row through the React Native form', () => {
    const { queryByTestId } = render(createElement(MoreForm, { model: customModel }));
    expect(queryByTestId('rn-form')).not.toBeNull();
    expect(queryByTestId('compose-host')).toBeNull();
  });

  it('keeps the Compose form for models without custom rows', () => {
    const { queryByTestId } = render(createElement(MoreForm, { model: plainModel }));
    expect(queryByTestId('compose-host')).not.toBeNull();
    expect(queryByTestId('rn-form')).toBeNull();
  });
});
