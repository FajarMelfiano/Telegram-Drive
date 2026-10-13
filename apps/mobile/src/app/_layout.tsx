import '../tg/polyfills'; // Buffer + crypto.getRandomValues global — sebelum modul lain
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useRef } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AuthProvider } from '../auth';
import { color } from '../theme';

// Web: matikan subpixel LCD AA (greyscale) agar glyph mono kecil tidak menghasilkan
// chromatic fringing yang terbaca sebagai garis/pil pelangi. Diterapkan langsung ke
// DOM root karena properti CSS ini tidak masuk tipe ViewStyle RN.
function useWebAntiFringe() {
  const ref = useRef<View>(null);
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const el = ref.current as unknown as HTMLElement | null;
    if (!el) return;
    el.style.setProperty('text-rendering', 'optimizeLegibility');
    el.style.setProperty('-webkit-font-smoothing', 'antialiased');
    el.style.setProperty('-moz-osx-font-smoothing', 'grayscale');
  }, []);
  return ref;
}

export default function RootLayout() {
  const rootRef = useWebAntiFringe();
  return (
    <SafeAreaProvider>
      <AuthProvider>
        <StatusBar style="dark" />
        <View ref={rootRef} style={styles.root}>
          <Stack
            screenOptions={{
              headerShown: false,
              contentStyle: { backgroundColor: color.base },
              animation: 'fade',
            }}
          >
            <Stack.Screen name="(tabs)" />
            <Stack.Screen name="login" />
          </Stack>
        </View>
      </AuthProvider>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({ root: { flex: 1, backgroundColor: color.base } });
