import type { ReactNode } from 'react';
import {
  ActivityIndicator, Pressable, StyleSheet, Text, View,
  type StyleProp, type ViewStyle,
} from 'react-native';
import { ArrowLeft } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { color, fontSize, hit, radius, scaleCap, shadow, space } from '../theme';

/**
 * Primitif UI "modern light teal" — satu sumber gaya untuk semua layar.
 * Aturan: semua target interaktif >= hit.min (44dp); judul/label dibatasi
 * scaling-nya (scaleCap); bayangan lembut hanya pada elemen terangkat.
 */

/** Layar berlatar terang. */
export function Screen({ children }: { children: ReactNode }) {
  return <View style={styles.screen}>{children}</View>;
}

/** Appbar teal penuh — membludak ke bawah status bar (inset atas otomatis). */
export function ScreenHeader({ title, subtitle, onBack, right }: {
  title: string;
  subtitle?: ReactNode;
  onBack?: () => void;
  right?: ReactNode;
}) {
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.header, { paddingTop: insets.top + space(1.5) }]}>
      {onBack ? (
        <IconBtn
          label="Kembali"
          onPress={onBack}
          icon={<ArrowLeft size={22} strokeWidth={2} color={color.onPrimary} />}
        />
      ) : null}
      <View style={styles.headerMain}>
        <Text style={styles.headerTitle} numberOfLines={1} maxFontSizeMultiplier={scaleCap.title}>
          {title}
        </Text>
        {typeof subtitle === 'string' ? (
          <Text style={styles.headerSubtitle} numberOfLines={1} maxFontSizeMultiplier={scaleCap.label}>
            {subtitle}
          </Text>
        ) : (
          subtitle
        )}
      </View>
      {right != null && <View style={styles.headerRight}>{right}</View>}
    </View>
  );
}

/** Tombol ikon 44x44 — sentuh nyaman, visual tenang. */
export function IconBtn({ icon, onPress, label }: {
  icon: ReactNode;
  onPress: () => void;
  label: string;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={4}
      style={({ pressed }) => [styles.iconBtn, pressed && styles.pressed]}
    >
      {icon}
    </Pressable>
  );
}

const BTN_TEXT = {
  primary: { color: color.onPrimary },
  ghost: { color: color.textMuted },
  danger: { color: color.onPrimary },
} as const;

/** Tombol utama/sekunder/bahaya — tinggi 48, radius 14. */
export function Btn({ label, onPress, variant = 'primary', busy, disabled, icon }: {
  label: string;
  onPress: () => void;
  variant?: 'primary' | 'ghost' | 'danger';
  busy?: boolean;
  disabled?: boolean;
  icon?: ReactNode;
}) {
  const variantStyle = {
    primary: styles.btnPrimary,
    ghost: styles.btnGhost,
    danger: styles.btnDanger,
  } as const;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || busy}
      accessibilityRole="button"
      accessibilityState={{ disabled: !!disabled || !!busy }}
      style={({ pressed }) => [
        styles.btn, variantStyle[variant],
        (disabled || busy) && styles.btnDisabled,
        pressed && !disabled && styles.pressed,
      ]}
    >
      {busy ? (
        <ActivityIndicator color={variant === 'ghost' ? color.primary : color.onPrimary} />
      ) : (
        <>
          {icon}
          <Text style={[styles.btnText, BTN_TEXT[variant]]} maxFontSizeMultiplier={scaleCap.label}>
            {label}
          </Text>
        </>
      )}
    </Pressable>
  );
}

/** FAB teal (aksi utama zona jempol). Posisi kanan-bawah diatur lewat style. */
export function Fab({ icon, onPress, label, style }: {
  icon: ReactNode;
  onPress: () => void;
  label: string;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => [styles.fab, shadow.float, pressed && styles.fabPressed, style]}
    >
      {icon}
    </Pressable>
  );
}

/** Chip status: titik berwarna + label pendek (latar tint lembut). */
export function Pill({ text, tint = color.primary, bg }: {
  text: string;
  tint?: string;
  bg?: string;
}) {
  return (
    <View style={[styles.pill, { backgroundColor: bg ?? color.primarySoft }]}>
      <View style={[styles.pillDot, { backgroundColor: tint }]} />
      <Text style={[styles.pillText, { color: tint }]} numberOfLines={1} maxFontSizeMultiplier={scaleCap.label}>
        {text}
      </Text>
    </View>
  );
}

/** Keadaan kosong/pusat yang terdesain: ikon + judul + penjelasan + aksi opsional. */
export function EmptyState({ icon, title, body, children }: {
  icon?: ReactNode;
  title: string;
  body?: string;
  children?: ReactNode;
}) {
  return (
    <View style={styles.empty}>
      {icon}
      <Text style={styles.emptyTitle} maxFontSizeMultiplier={scaleCap.title}>{title}</Text>
      {body ? <Text style={styles.emptyBody} maxFontSizeMultiplier={scaleCap.label}>{body}</Text> : null}
      {children}
    </View>
  );
}

/** Kartu putih terangkat — radius 16 + bayangan lembut. */
export function Card({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[styles.card, shadow.card, style]}>{children}</View>;
}

/** Label seksi sentence-case (pengganti eyebrow ALL-CAPS tracked). */
export function SectionLabel({ children }: { children: ReactNode }) {
  return <Text style={styles.sectionLabel} maxFontSizeMultiplier={scaleCap.label}>{children}</Text>;
}

/** Gaya input bersama — putih, tinggi alami ~48. */
export const inputStyle = StyleSheet.create({
  base: {
    borderWidth: 1, borderColor: color.hairline, borderRadius: radius.control,
    backgroundColor: color.surface, color: color.textPrimary,
    paddingHorizontal: space(3.5), paddingVertical: space(3),
    fontSize: fontSize.base,
  },
  mono: {
    borderWidth: 1, borderColor: color.hairline, borderRadius: radius.control,
    backgroundColor: color.surface, color: color.textPrimary,
    paddingHorizontal: space(3.5), paddingVertical: space(3),
    fontFamily: 'monospace', fontSize: fontSize.base,
  },
});

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: color.base },
  header: {
    backgroundColor: color.primary,
    flexDirection: 'row', alignItems: 'center', gap: space(2),
    paddingHorizontal: space(4), paddingBottom: space(3.5),
  },
  headerMain: { flex: 1, minWidth: 0 },
  headerTitle: { color: color.onPrimary, fontSize: fontSize.lg, fontWeight: '700', letterSpacing: -0.2 },
  headerSubtitle: { color: 'rgba(255,255,255,0.82)', fontSize: fontSize.sm, marginTop: 2 },
  headerRight: { flexDirection: 'row', alignItems: 'center', gap: space(1) },
  iconBtn: {
    minWidth: hit.min, minHeight: hit.min, alignItems: 'center', justifyContent: 'center',
    borderRadius: radius.control,
  },
  pressed: { opacity: 0.65 },
  btn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: space(2),
    minHeight: 48, paddingHorizontal: space(5), borderRadius: radius.container,
  },
  btnPrimary: { backgroundColor: color.primary },
  btnGhost: { borderWidth: 1, borderColor: color.hairline, backgroundColor: color.surface },
  btnDanger: { backgroundColor: color.red },
  btnDisabled: { opacity: 0.45 },
  btnText: { fontSize: fontSize.base, fontWeight: '700' },
  fab: {
    position: 'absolute', right: space(4),
    width: 56, height: 56, borderRadius: radius.fab,
    backgroundColor: color.primary, alignItems: 'center', justifyContent: 'center',
  },
  fabPressed: { backgroundColor: color.primaryDark },
  pill: {
    flexDirection: 'row', alignItems: 'center', gap: space(1.5),
    borderRadius: radius.chip, paddingHorizontal: space(2.5), minHeight: 28,
    maxWidth: 170,
  },
  pillDot: { width: 6, height: 6, borderRadius: 3 },
  pillText: { fontSize: fontSize.xs, fontWeight: '600' },
  empty: { alignItems: 'center', gap: space(3), padding: space(8), maxWidth: 420, alignSelf: 'center' },
  emptyTitle: { color: color.textPrimary, fontSize: fontSize.md, fontWeight: '600', textAlign: 'center' },
  emptyBody: { color: color.textMuted, fontSize: fontSize.sm, textAlign: 'center', lineHeight: 20 },
  card: {
    backgroundColor: color.surface, borderWidth: 1, borderColor: color.hairline,
    borderRadius: radius.card, overflow: 'hidden',
  },
  sectionLabel: { color: color.textMuted, fontSize: fontSize.sm, fontWeight: '600', marginBottom: space(2) },
});
