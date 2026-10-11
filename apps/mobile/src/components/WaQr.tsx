import { useEffect, useState } from 'react';
import { ActivityIndicator, Image, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { color, font, fontSize, radius, space } from '../theme';

/**
 * Menampilkan QR koneksi WhatsApp (dari string pairing Baileys) agar HP lain
 * bisa memindai & menautkan akun. QR dirender via qrcode (lazy, web-only);
 * di native ditampilkan string-nya sebagai fallback teks.
 */
export function WaQr({ data }: { data: string }) {
  const [uri, setUri] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (Platform.OS !== 'web') return;
    void (async () => {
      try {
        const QRCode = (await import('qrcode')).default;
        const url = await QRCode.toDataURL(data, {
          margin: 1, width: 200, color: { dark: '#0B0C0E', light: '#FFFFFF' },
        });
        if (!cancelled) setUri(url);
      } catch { /* fallback teks */ }
    })();
    return () => { cancelled = true; };
  }, [data]);

  if (Platform.OS !== 'web') {
    return (
      <View style={styles.box}>
        <Text style={styles.title}>PINDAI DARI WHATSAPP</Text>
        <Text style={styles.code} selectable>{data}</Text>
      </View>
    );
  }

  return (
    <View style={styles.box}>
      <Text style={styles.title}>PINDAI DARI WHATSAPP</Text>
      <View style={styles.qrBox}>
        {uri ? <Image source={{ uri }} style={styles.qr} resizeMode="contain" />
             : <ActivityIndicator color={color.amber} />}
      </View>
      <Text style={styles.hint}>WhatsApp → Perangkat Tertaut → Tautkan Perangkat</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  box: { borderWidth: 1, borderColor: color.hairline, backgroundColor: color.base, padding: space(3), marginTop: space(3), alignItems: 'center' },
  title: { fontFamily: font.mono, fontSize: fontSize.xs, color: color.amber, letterSpacing: 1.5, marginBottom: space(3) },
  qrBox: { width: 212, height: 212, alignItems: 'center', justifyContent: 'center', backgroundColor: '#FFFFFF', padding: space(2) },
  qr: { width: 200, height: 200 },
  hint: { fontFamily: font.mono, fontSize: fontSize.xs, color: color.textFaint, letterSpacing: 0.5, marginTop: space(3), textAlign: 'center' },
  code: { fontFamily: font.mono, fontSize: fontSize.sm, color: color.textPrimary, textAlign: 'center' },
});
