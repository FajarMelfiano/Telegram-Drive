import { useCallback, useState } from 'react';
import { ActivityIndicator, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { Api, ApiError } from '../api';
import { useAuth } from '../auth';
import { color, font, fontSize, radius, space } from '../theme';

const HEX10 = /^[0-9a-f]{10}$/i;

/**
 * Pemindai QR (HP yang sudah login) untuk menyetujui pasangan perangkat web.
 * Memindai QR web → ekstrak kode 10-hex → POST /approve. Token TIDAK pernah
 * dibaca dari QR — hanya kode pairing.
 */
export function PairApproveScreen({ onDone }: { onDone: () => void }) {
  const { token } = useAuth();
  const [permission, requestPermission] = useCameraPermissions();
  const [status, setStatus] = useState<'idle' | 'approving' | 'ok' | 'error'>('idle');
  const [msg, setMsg] = useState<string | null>(null);

  const approve = useCallback(async (raw: string) => {
    if (status === 'approving' || status === 'ok') return;
    const code = raw.trim().toLowerCase();
    if (!HEX10.test(code)) {
      setMsg('Bukan kode pairing Telegram Drive.');
      setStatus('error');
      return;
    }
    setStatus('approving'); setMsg(null);
    try {
      await Api.approvePairing(token, code);
      setStatus('ok');
      setMsg('Perangkat web disetujui. Selesaikan login di web.');
    } catch (err) {
      setStatus('error');
      setMsg(err instanceof ApiError
        ? (err.code === 'PAIRING_EXPIRED' ? 'Kode kedaluwarsa. Muat ulang QR di web.'
          : err.code === 'PAIRING_ALREADY_APPROVED' ? 'Kode sudah disetujui.'
          : `Gagal (${err.code})`)
        : 'Server tidak terjangkau.');
    }
  }, [token, status]);

  if (!permission) return <View style={styles.flex} />;

  if (!permission.granted) {
    return (
      <View style={styles.center}>
        <Text style={styles.title}>IZINKAN KAMERA</Text>
        <Text style={styles.note}>Kamera dipakai untuk memindai QR pasangan perangkat web. Tidak ada gambar yang disimpan.</Text>
        <Pressable onPress={() => void requestPermission()} style={({ pressed }) => [styles.btn, pressed && { opacity: 0.85 }]}>
          <Text style={styles.btnText}>IZINKAN KAMERA</Text>
        </Pressable>
        <Pressable onPress={onDone} style={styles.ghost}><Text style={styles.ghostText}>NANTI</Text></Pressable>
      </View>
    );
  }

  return (
    <View style={styles.flex}>
      {status !== 'ok' && Platform.OS !== 'web' ? (
        <CameraView
          style={StyleSheet.absoluteFill}
          facing="back"
          barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
          onBarcodeScanned={({ data }) => { void approve(data); }}
        />
      ) : null}

      <View style={styles.overlay}>
        <View style={styles.frame} />
        <Text style={styles.hint}>Arahkan ke QR di layar web</Text>

        {status === 'approving' && (
          <View style={styles.badge}><ActivityIndicator color={color.base} size="small" /><Text style={styles.badgeText}>Menyetujui…</Text></View>
        )}
        {status === 'ok' && (
          <View style={[styles.badge, { backgroundColor: color.green }]}>
            <Text style={styles.badgeText}>✓ {msg}</Text>
          </View>
        )}
        {status === 'error' && msg && (
          <View style={[styles.badge, { backgroundColor: color.red }]}><Text style={styles.badgeText}>{msg}</Text></View>
        )}
        {status === 'idle' && !msg && <View style={styles.badge}><Text style={styles.badgeTextDark}>Pindai QR…</Text></View>}

        <Pressable onPress={onDone} style={styles.close}><Text style={styles.ghostText}>TUTUP</Text></Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: color.base },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: space(6) },
  title: { fontFamily: font.mono, fontSize: fontSize.sm, color: color.amber, letterSpacing: 2, marginBottom: space(3) },
  note: { color: color.textMuted, fontSize: fontSize.sm, textAlign: 'center', lineHeight: 18, marginBottom: space(5) },
  btn: { backgroundColor: color.amber, borderRadius: radius.control, paddingVertical: space(3), paddingHorizontal: space(6) },
  btnText: { color: color.base, fontWeight: '700', letterSpacing: 1.5, fontSize: fontSize.sm },
  ghost: { paddingVertical: space(3), marginTop: space(2) },
  ghostText: { color: color.textMuted, fontSize: fontSize.sm, letterSpacing: 1 },
  overlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(11,12,14,0.35)' },
  frame: { width: 220, height: 220, borderWidth: 2, borderColor: color.amber, borderRadius: radius.control, marginBottom: space(4) },
  hint: { color: color.textPrimary, fontSize: fontSize.sm, marginBottom: space(4), letterSpacing: 1 },
  badge: {
    flexDirection: 'row', alignItems: 'center', gap: space(2),
    backgroundColor: color.amber, borderRadius: radius.chip, paddingHorizontal: space(4), paddingVertical: space(2), marginBottom: space(4),
  },
  badgeText: { color: color.base, fontWeight: '700', fontSize: fontSize.sm },
  badgeTextDark: { color: color.base, fontSize: fontSize.sm },
  close: { paddingVertical: space(3), marginTop: space(2) },
});
