import { StyleSheet, Text, View } from 'react-native';
import { color, font, fontSize, space } from '../theme';

/** Layar tunggal saat memulihkan sesi dari penyimpanan. */
export function BootScreen({ label = 'MEMULIHKAN SESI…' }: { label?: string }) {
  return (
    <View style={styles.root}>
      <Text style={styles.brand}>TELEGRAM DRIVE</Text>
      <Text style={styles.label}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.base, alignItems: 'center', justifyContent: 'center', gap: space(3) },
  brand: { color: color.textPrimary, fontSize: fontSize.xl, fontWeight: '700', letterSpacing: 3 },
  label: { fontFamily: font.mono, fontSize: fontSize.xs, color: color.amber, letterSpacing: 2 },
});
