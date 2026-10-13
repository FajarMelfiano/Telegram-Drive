import { StyleSheet, Text, View } from 'react-native';
import { color, fontSize, scaleCap, space } from '../theme';

/** Layar tunggal saat memulihkan sesi dari penyimpanan. */
export function BootScreen({ label = 'Memulihkan sesi…' }: { label?: string }) {
  return (
    <View style={styles.root}>
      <View style={styles.logo}>
        <Text style={styles.logoText}>TD</Text>
      </View>
      <Text style={styles.brand} maxFontSizeMultiplier={scaleCap.title}>Telegram Drive</Text>
      <Text style={styles.label} maxFontSizeMultiplier={scaleCap.label}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.base, alignItems: 'center', justifyContent: 'center', gap: space(3) },
  logo: {
    width: 64, height: 64, borderRadius: 20, backgroundColor: color.primary,
    alignItems: 'center', justifyContent: 'center', marginBottom: space(1),
  },
  logoText: { color: color.onPrimary, fontSize: fontSize.lg, fontWeight: '700' },
  brand: { color: color.textPrimary, fontSize: fontSize.xl, fontWeight: '700', letterSpacing: -0.3 },
  label: { color: color.textMuted, fontSize: fontSize.sm },
});
