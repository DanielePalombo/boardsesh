import { describe, expect, it, vi } from 'vitest';
import { buildAccountRows } from '../account-rows';

describe('Settings › Account rows', () => {
  it('always lists Privacy, so the anonymity switch is reachable with account privacy controls off', () => {
    const onPrivacy = vi.fn();
    const rows = buildAccountRows({
      labels: { editProfile: 'Edit profile', privacy: 'Privacy', exportData: 'Export' },
      onEditProfile: vi.fn(),
      onPrivacy,
      onExportData: vi.fn(),
    });
    expect(rows.map((row) => row.key)).toEqual(['editProfile', 'privacy', 'exportData']);
    const privacy = rows.find((row) => row.key === 'privacy');
    expect(privacy?.label).toBe('Privacy');
    privacy?.onPress();
    expect(onPrivacy).toHaveBeenCalledOnce();
  });
});
