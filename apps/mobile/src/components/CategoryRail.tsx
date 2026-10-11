import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { CategoryRow } from '../api';
import { color, font, fontSize, space } from '../theme';

/**
 * Rail kategori ("lorong gudang"): Semua + per kategori dengan jumlah baris.
 * Di layar sempit dipakai sebagai baris chip horizontal.
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
  return (
    <View style={[layout === 'vertical' ? styles.rail : styles.strip]}>
      {items.map((item) => {
        const isActive = item.key === active;
        return (
          <Pressable
            key={item.key ?? 'all'}
            onPress={() => onSelect(item.key)}
            style={({ pressed }) => [
              layout === 'vertical' ? styles.item : styles.itemH,
              isActive && styles.itemActive,
              pressed && { opacity: 0.7 },
            ]}
          >
            {isActive ? <View style={styles.marker} /> : null}
            <Text
              style={[styles.label, isActive && styles.labelActive]}
              numberOfLines={1}
            >
              {item.label.toUpperCase()}
            </Text>
            <Text style={[styles.count, isActive && styles.labelActive]}>{item.fileCount}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  rail: { borderRightWidth: 1, borderRightColor: color.hairline, paddingTop: space(2) },
  strip: { flexDirection: 'row', flexWrap: 'wrap', gap: space(2), paddingVertical: space(2) },
  item: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space(2),
    paddingHorizontal: space(3),
    paddingVertical: space(2.5),
    borderLeftWidth: 2,
    borderLeftColor: 'transparent',
  },
  itemH: {
    borderWidth: 1,
    borderColor: color.hairline,
    borderLeftWidth: 1,
    borderRadius: 4,
    paddingVertical: space(1.5),
    paddingHorizontal: space(3),
  },
  itemActive: { borderLeftColor: color.amber, backgroundColor: color.surfaceAlt },
  marker: { width: 4, height: 4, borderRadius: 2, backgroundColor: color.amber },
  label: { color: color.textMuted, fontSize: fontSize.sm, letterSpacing: 0.8, flexShrink: 1 },
  labelActive: { color: color.amber },
  count: { fontFamily: font.mono, fontSize: fontSize.xs, color: color.textFaint, marginLeft: 'auto' },
});
