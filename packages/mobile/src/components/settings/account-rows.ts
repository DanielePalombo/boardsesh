import type { MoreNavRow } from '../MoreForm.types';

/**
 * The Account section's rows for a signed-in climber. Privacy is always one of
 * them: its "Stay anonymous on boards I don't own" switch works whether or not
 * the server has account privacy controls on, and the screen itself hides the
 * controls that need them.
 */
export function buildAccountRows({
  labels,
  onEditProfile,
  onPrivacy,
  onExportData,
}: {
  labels: { editProfile: string; privacy: string; exportData: string };
  onEditProfile: () => void;
  onPrivacy: () => void;
  onExportData: () => void;
}): MoreNavRow[] {
  return [
    { kind: 'nav', key: 'editProfile', label: labels.editProfile, icon: 'editProfile', onPress: onEditProfile },
    { kind: 'nav', key: 'privacy', label: labels.privacy, onPress: onPrivacy },
    { kind: 'nav', key: 'exportData', label: labels.exportData, onPress: onExportData },
  ];
}
