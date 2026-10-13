import { Tabs } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Archive, Search } from 'lucide-react-native';
import { color, fontSize } from '../../theme';

/**
 * Tab bawah: pill teal melayang (mengikuti referensi user).
 * Posisi absolute + margin — tinggi bar tidak lagi menentukan height tetap
 * (akar bug label ketutup gesture bar pada build lama sudah dibuang).
 */
export default function TabsLayout() {
  const insets = useSafeAreaInsets();
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: color.onPrimary,
        tabBarInactiveTintColor: 'rgba(255,255,255,0.72)',
        tabBarStyle: {
          position: 'absolute',
          left: 16,
          right: 16,
          bottom: Math.max(insets.bottom, 8) + 8,
          height: 58,
          backgroundColor: color.primary,
          borderTopWidth: 0,
          borderRadius: 20,
          paddingTop: 6,
          paddingBottom: 6,
          shadowColor: '#0F2420',
          shadowOpacity: 0.16,
          shadowRadius: 16,
          shadowOffset: { width: 0, height: 6 },
          elevation: 10,
        },
        tabBarLabelStyle: { fontSize: fontSize.xs, fontWeight: '600' },
        tabBarIconStyle: { marginTop: 2 },
        sceneStyle: { backgroundColor: color.base },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: 'Manifest',
          tabBarIcon: ({ color: tint, size }) => (
            <Archive size={size} color={tint} strokeWidth={2} />
          ),
        }}
      />
      <Tabs.Screen
        name="search"
        options={{
          title: 'Cari',
          tabBarIcon: ({ color: tint, size }) => (
            <Search size={size} color={tint} strokeWidth={2} />
          ),
        }}
      />
    </Tabs>
  );
}
