import { Tabs } from 'expo-router';
import { Archive, Search } from 'lucide-react-native';
import { color, font } from '../../theme';

/** Tab bawah: dua lorong utama gudang — manifest & pencarian. */
export default function TabsLayout() {
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: color.amber,
        tabBarInactiveTintColor: color.textFaint,
        tabBarStyle: {
          backgroundColor: color.base,
          borderTopColor: color.hairline,
          borderTopWidth: 1,
          height: 58,
          paddingTop: 6,
          paddingBottom: 8,
        },
        tabBarLabelStyle: { fontFamily: font.mono, fontSize: 10, letterSpacing: 1.5 },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: 'MANIFEST',
          tabBarIcon: ({ color: tint, size }) => (
            <Archive size={size} color={tint} strokeWidth={1.5} />
          ),
        }}
      />
      <Tabs.Screen
        name="search"
        options={{
          title: 'CARI',
          tabBarIcon: ({ color: tint, size }) => (
            <Search size={size} color={tint} strokeWidth={1.5} />
          ),
        }}
      />
    </Tabs>
  );
}
