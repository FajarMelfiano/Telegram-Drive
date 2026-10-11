import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Image, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { Api, ApiError } from '../api';
import { color, font, fontSize, space } from '../theme';

const POLL_MS = 2000;

type Phase = 'creating' | 'waiting' | 'redeeming' | 'error';

/**
 * Panel login QR untuk WEB: buat kode pairing (tanpa login) → gambar QR →
 * poll sampai HP yang sudah login menyetujui → tukar kode jadi token.
 * QR hanya membawa KODE pairing (10 hex), tidak pernah token.
 * Hanya dirender di web (HP adalah pemindai, bukan penampil).
 */
export function PairQrPanel({ onLoggedIn, onBack }: {
  onLoggedIn: (token: string, refreshToken?: string) => void;
  onBack: () => void;
}) {
  const [phase, setPhase] = useState<Phase>('creating');
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [code, setCode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const codeRef = useRef<string | null>(null);
  const cancelledRef = useRef(false);

  // Render QR dari kode (lazy import qrcode — hanya web yang punya canvas).
  const renderQr = useCallback(async (value: string) => {
    if (Platform.OS !== 'web') return;
    try {
      const QRCode = (await import('qrcode')).default;
      const url = await QRCode.toDataURL(value, {
        margin: 1, width: 220, color: { dark: '#0B0C0E', light: '#FFFFFF' },
      });
      if (!cancelledRef.current) setQrDataUrl(url);
    } catch {
      // QR gagal dirender → tampilkan kode teks sebagai fallback (tetap bisa diketik HP)
    }
  }, []);

  const start = useCallback(async () => {
    setPhase('creating'); setError(null); setQrDataUrl(null);
    try {
      const { code: newCode } = await Api.createPairing('Web');
      if (cancelledRef.current) return;
      codeRef.current = newCode;
      setCode(newCode);
      setPhase('waiting');
      await renderQr(newCode);
    } catch (err) {
      if (cancelledRef.current) return;
      setError(err instanceof ApiError ? `Gagal membuat kode (${err.code})` : 'Server tidak terjangkau.');
      setPhase('error');
    }
  }, [renderQr]);

  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    cancelledRef.current = false;
    void start();
    return () => { cancelledRef.current = true; };
  }, [start]);
  /* eslint-enable react-hooks/set-state-in-effect */

  // Poll status sampai disetujui → langsung tukar jadi token.
  useEffect(() => {
    if (phase !== 'waiting' || !code) return;
    let stop = false;
    const tick = async () => {
      if (stop || cancelledRef.current) return;
      try {
        const { status } = await Api.pollPairing(code);
        if (stop || cancelledRef.current) return;
        if (status === 'approved') {
          setPhase('redeeming');
          const { token, refreshToken } = await Api.claimPairing(code);
          if (!cancelledRef.current) onLoggedIn(token, refreshToken);
          return;
        }
        if (status === 'redeemed') {
          setError('Kode sudah dipakai perangkat lain. Buat kode baru.');
          setPhase('error');
          return;
        }
      } catch (err) {
        if (stop || cancelledRef.current) return;
        if (err instanceof ApiError && err.status === 410) {
          setError('Kode kedaluwarsa (5 menit). Buat kode baru.');
          setPhase('error');
          return;
        }
        // error jaringan sesaat → lanjut poll
      }
      if (!stop) setTimeout(() => { void tick(); }, POLL_MS);
    };
    const first = setTimeout(() => { void tick(); }, POLL_MS);
    return () => { stop = true; clearTimeout(first); };
  }, [phase, code, onLoggedIn]);

  return (
    <View style={styles.panel}>
      <Text style={styles.title}>PASANGKAN DENGAN HP</Text>
      <Text style={styles.note}>
        Di HP yang sudah masuk Telegram Drive: Setelan → Pasangkan perangkat web → pindai QR ini.
      </Text>

      <View style={styles.qrBox}>
        {phase === 'creating' && <ActivityIndicator color={color.amber} />}
        {phase !== 'creating' && qrDataUrl && (
          <Image source={{ uri: qrDataUrl }} style={styles.qr} resizeMode="contain" />
        )}
        {phase !== 'creating' && !qrDataUrl && (
          <Text style={styles.qrFallback}>Menyiapkan QR…</Text>
        )}
      </View>

      {code && (
        <View style={styles.codeRow}>
          <Text style={styles.codeLabel}>KODE</Text>
          <Text style={styles.codeValue}>{code}</Text>
        </View>
      )}

      <View style={styles.statusRow}>
        {phase === 'waiting' && (
          <>
            <ActivityIndicator color={color.amber} size="small" />
            <Text style={styles.statusText}>Menunggu persetujuan dari HP…</Text>
          </>
        )}
        {phase === 'redeeming' && <Text style={styles.statusText}>Sesi diterbitkan…</Text>}
        {phase === 'creating' && <Text style={styles.statusText}>Membuat kode…</Text>}
      </View>

      {error && <Text style={styles.error}>{error}</Text>}

      {(phase === 'error' || phase === 'waiting') && (
        <Pressable onPress={() => { void start(); }} style={({ pressed }) => [styles.ghost, pressed && { opacity: 0.6 }]}>
          <Text style={styles.ghostText}>{phase === 'error' ? 'BUAT KODE BARU' : 'MUAT ULANG QR'}</Text>
        </Pressable>
      )}
      <Pressable onPress={onBack} style={({ pressed }) => [styles.ghost, pressed && { opacity: 0.6 }]}>
        <Text style={styles.ghostText}>MASUK DENGAN API ID/OTP</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  panel: { borderWidth: 1, borderColor: color.hairline, backgroundColor: color.surface, padding: space(5) },
  title: { fontFamily: font.mono, fontSize: fontSize.sm, color: color.amber, letterSpacing: 2, marginBottom: space(2) },
  note: { color: color.textMuted, fontSize: fontSize.sm, lineHeight: 18, marginBottom: space(4) },
  qrBox: {
    minHeight: 236, alignItems: 'center', justifyContent: 'center',
    borderWidth: 1, borderColor: color.hairline, backgroundColor: '#FFFFFF', padding: space(3),
  },
  qr: { width: 220, height: 220 },
  qrFallback: { fontFamily: font.mono, fontSize: fontSize.sm, color: color.textFaint },
  codeRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    marginTop: space(3), borderTopWidth: 1, borderTopColor: color.hairline, paddingTop: space(3),
  },
  codeLabel: { fontFamily: font.mono, fontSize: fontSize.xs, color: color.textFaint, letterSpacing: 1 },
  codeValue: { fontFamily: font.mono, fontSize: fontSize.lg, color: color.textPrimary, letterSpacing: 3 },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: space(2), marginTop: space(4) },
  statusText: { color: color.textMuted, fontSize: fontSize.sm },
  error: { color: color.red, fontSize: fontSize.sm, marginTop: space(3) },
  ghost: { paddingVertical: space(3), alignItems: 'center', marginTop: space(1) },
  ghostText: { color: color.textMuted, fontSize: fontSize.sm, letterSpacing: 1 },
});
