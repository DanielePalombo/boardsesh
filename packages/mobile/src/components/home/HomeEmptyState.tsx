import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Button } from '../Button';
import { Icon } from '../Icon';
import { Text } from '../Text';
import { useTheme } from '../../providers/theme-provider';
import { spacing } from '../../theme/tokens';

/** Every section switched off. The header buttons stay, so notifications and find climbers still work. */
export function HomeEmptyState({ onCustomize }: { onCustomize: () => void }) {
  const { t } = useTranslation('feed');
  const { t: tCommon } = useTranslation('common');
  const { systemColors } = useTheme();
  return (
    <View style={styles.container} testID="home-empty">
      <Icon name="home" size={48} color={systemColors.tertiaryLabel} />
      <Text variant="headline" style={styles.title}>
        {t('mobile.home.sections.empty.title')}
      </Text>
      <Text variant="subheadline" color={systemColors.secondaryLabel} style={styles.body}>
        {t('mobile.home.sections.empty.body')}
      </Text>
      <View style={styles.cta}>
        <Button
          title={tCommon('mobile.settings.homeSections.customize')}
          icon="view.options"
          onPress={onCustomize}
          testID="home-empty-customize"
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: spacing[12],
    paddingHorizontal: spacing[8],
    gap: spacing[2],
  },
  title: {
    marginTop: spacing[3],
    textAlign: 'center',
  },
  body: {
    textAlign: 'center',
  },
  cta: {
    marginTop: spacing[4],
  },
});
