import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { CategoryRow } from '../api';
import { color, fontSize, radius, scaleCap, space } from '../theme';

/**
 * Rail kategori ("lorong gudang"): Semua + per kategori dengan jumlah baris.
 * Di layar sempit dipakai sebagai chip horizontal yang bisa digulir.
 */
export function CategoryRail({
  categories,
  active,
  onSelect,
  layout = 'vertical',
}: {
  categories: CategoryRow[];
  active: string | null;
  onSelect: (key: string | null) => void;
  layout?: 'vertical' | 'horizontal';
}) {
  const items = [{ key: null, label: 'Semua', fileCount: categories.reduce((a, c) => a + c.fileCount, 0) }, ...categories];

  if (layout === 'horizontal') {
    return (
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.strip}
      >
        {items.map((item) => {
          const isActive = item.key === active;
          return (
            <Pressable
              key={item.key ?? 'all'}
              onPress={() => onSelect(item.key)}
              accessibilityRole="button"
              accessibilityState={{ selected: isActive }}
              style={({ pressed }) => [
                styles.chip,
                isActive && styles.chipActive,
                pressed && { opacity: 0.7 },
              ]}
            >
              <Text
                style={[styles.chipLabel, isActive && styles.chipLabelActive]}
                numberOfLines={1}
                maxFontSizeMultiplier={scaleCap.label}
              >
                {item.label}
              </Text>
              <Text style={[styles.chipCount, isActive && styles.chipLabelActive]} maxFontSizeMultiplier={scaleCap.label}>
                {item.fileCount}
              </Text>
            </Pressable>
          );
        })}
      </ScrollView>
    );
  }

  return (
    <View style={styles.rail}>
      {items.map((item) => {
        const isActive = item.key === active;
        return (
          <Pressable
            key={item.key ?? 'all'}
            onPress={() => onSelect(item.key)}
            accessibilityRole="button"
            accessibilityState={{ selected: isActive }}
            style={({ pressed }) => [
              styles.item,
              isActive && styles.itemActive,
              pressed && { opacity: 0.7 },
            ]}
          >
            <Text
              style={[styles.label, isActive && styles.labelActive]}
              numberOfLines={1}
              maxFontSizeMultiplier={scaleCap.label}
            >
              {item.label}
            </Text>
            <Text style={[styles.count, isActive && styles.labelActive]} maxFontSizeMultiplier={scaleCap.label}>
              {item.fileCount}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  rail: { paddingTop: space(2), gap: space(1), paddingHorizontal: space(2) },
  strip: { flexDirection: 'row', gap: space(2), paddingVertical: space(2), paddingHorizontal: space(4) },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space(1.5),
    borderWidth: 1,
    borderColor: color.hairline,
    borderRadius: radius.chip,
    backgroundColor: color.surface,
    paddingVertical: space(1.5),
    paddingHorizontal: space(3),
    minHeight: 36,
  },
  chipActive: { backgroundColor: color.primary, borderColor: color.primary },
  chipLabel: { color: color.textMuted, fontSize: fontSize.sm, fontWeight: '600', flexShrink: 1 },
  chipLabelActive: { color: color.onPrimary },
  chipCount: { color: color.textFaint, fontSize: fontSize.xs, fontWeight: '600' },
  item: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space(2),
    minHeight: 44,
    paddingHorizontal: space(3),
    borderRadius: radius.control,
  },
  itemActive: { backgroundColor: color.primarySoft },
  label: { color: color.textMuted, fontSize: fontSize.sm, flexShrink: 1 },
  labelActive: { color: color.primary, fontWeight: '700' },
  count: { fontFamily: 'monospace', fontSize: fontSize.xs, color: color.textFaint, marginLeft: 'auto' },
});
