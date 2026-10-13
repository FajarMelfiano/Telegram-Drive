import { useState } from 'react';
import {
  ActivityIndicator, KeyboardAvoidingView, Platform, Pressable,
  ScrollView, StyleSheet, Text, TextInput, View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Api, ApiError } from '../api';
import { PairQrPanel } from '../components/PairQrPanel';
import type { StoredSession } from '../tg/session';
import { color, fontSize, radius, scaleCap, space } from '../theme';
import { Card, inputStyle, Screen } from '../components/ui';

type Step = 'api' | 'phone' | 'otp' | 'password';
type Mode = 'form' | 'qr';

const ERROR_TEXT: Record<string, string> = {
  PHONE_NUMBER_INVALID: 'Nomor tidak dikenal Telegram. Pakai format +62…',
  PHONE_CODE_INVALID: 'Kode salah atau kedaluwarsa. Cek lagi dari Telegram.',
  PASSWORD_INVALID: 'Password 2FA salah.',
  API_INVALID: 'API ID atau Hash ditolak Telegram. Periksa di my.telegram.org.',
  FLOOD_WAIT: 'Telegram minta jeda. Coba lagi nanti.',
  TELEGRAM_ERROR: 'Koneksi ke Telegram gagal. Coba lagi.',
};

/** Layar masuk: API ID/Hash → nomor → OTP → (opsional) password 2FA. */
export function LoginScreen({ onLoggedIn }: { onLoggedIn: (token: string, extra?: string | StoredSession) => void }) {
  const insets = useSafeAreaInsets();
  const [mode, setMode] = useState<Mode>(Platform.OS === 'web' ? 'form' : 'form');
  const [step, setStep] = useState<Step>('api');
  const [apiId, setApiId] = useState('');
  const [apiHash, setApiHash] = useState('');
  const [phone, setPhone] = useState('+62');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [requestId, setRequestId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const showError = (err: unknown) => {
    if (err instanceof ApiError) setError(ERROR_TEXT[err.code] ?? `Gagal (${err.code})`);
    else setError('Server tidak terjangkau. Pastikan server jalan.');
  };

  /**
   * Susun StoredSession dari respons login lokal (hanya mode native — web
   * menyimpan sesi di server via cookie httpOnly, tidak ada session string).
   */
  const toStored = (
    res: { session?: string; apiId?: number; apiHash?: string },
  ): StoredSession | undefined => {
    if (res.session == null || res.apiId == null || res.apiHash == null) return undefined;
    return {
      apiId: res.apiId,
      apiHash: res.apiHash,
      session: res.session,
      phone: phone.trim(),
      tgUserId: null,
      tgName: null,
    };
  };

  const submitApi = async () => {
    setBusy(true); setError(null);
    try {
      const res = await Api.startAuth(Number(apiId), apiHash.trim(), phone.trim(), null);
      setRequestId(res.requestId);
      setStep('otp');
    } catch (err) { showError(err); } finally { setBusy(false); }
  };

  const submitCode = async () => {
    if (!requestId) return;
    setBusy(true); setError(null);
    try {
      const res = await Api.verify(requestId, code.trim(), null);
      if (res.status === 'password_required') { setStep('password'); return; }
      if (res.token) onLoggedIn(res.token, toStored(res));
    } catch (err) { showError(err); } finally { setBusy(false); }
  };

  const submitPassword = async () => {
    if (!requestId) return;
    setBusy(true); setError(null);
    try {
      const res = await Api.password(requestId, password, null);
      onLoggedIn(res.token, toStored(res));
    } catch (err) { showError(err); } finally { setBusy(false); }
  };

  const stepNo = step === 'api' ? 1 : step === 'phone' ? 2 : step === 'otp' ? 2 : 2;

  return (
    <Screen>
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView
          contentContainerStyle={[styles.container, { paddingTop: insets.top + space(10), paddingBottom: insets.bottom + space(10) }]}
          keyboardShouldPersistTaps="handled"
        >
          <View style={styles.header}>
            <View style={styles.logo}>
              <Text style={styles.logoText}>TD</Text>
            </View>
            <Text style={styles.brand} maxFontSizeMultiplier={scaleCap.title}>Telegram Drive</Text>
            <Text style={styles.sub} maxFontSizeMultiplier={scaleCap.label}>Gudang pribadi · manifest otomatis</Text>
          </View>

          {Platform.OS === 'web' && mode === 'qr' ? (
            <Card style={styles.panelWide}>
              <PairQrPanel onLoggedIn={(token) => onLoggedIn(token)} onBack={() => setMode('form')} />
            </Card>
          ) : (
            <Card style={styles.panel}>
              <Text style={styles.stepLabel} maxFontSizeMultiplier={scaleCap.label}>
                Langkah {stepNo} · {step === 'api' ? 'Kredensial API' : step === 'phone' ? 'Nomor telepon' : step === 'otp' ? 'Kode OTP' : 'Password 2FA'}
              </Text>

              {step === 'api' && (
                <>
                  <Field label="API ID" hint="my.telegram.org → API development tools">
                    <TextInput
                      style={[inputStyle.mono, styles.inputMono]}
                      value={apiId}
                      onChangeText={setApiId}
                      keyboardType="number-pad"
                      placeholder="123456"
                      placeholderTextColor={color.textFaint}
                      maxFontSizeMultiplier={scaleCap.label}
                    />
                  </Field>
                  <Field label="API HASH" hint="32 karakter hex — jangan bagikan ke siapa pun">
                    <TextInput
                      style={[inputStyle.mono, styles.inputMono]}
                      value={apiHash}
                      onChangeText={setApiHash}
                      autoCapitalize="none"
                      placeholder="a1b2c3…"
                      placeholderTextColor={color.textFaint}
                      secureTextEntry
                      maxFontSizeMultiplier={scaleCap.label}
                    />
                  </Field>
                  <Field label="Nomor telepon" hint="Format internasional, contoh +6281234567890">
                    <TextInput
                      style={[inputStyle.mono, styles.inputMono]}
                      value={phone}
                      onChangeText={setPhone}
                      keyboardType="phone-pad"
                      placeholder="+62…"
                      placeholderTextColor={color.textFaint}
                      maxFontSizeMultiplier={scaleCap.label}
                    />
                  </Field>
                  <PrimaryButton label="Kirim kode OTP" onPress={submitApi} busy={busy}
                    disabled={!apiId || apiHash.trim().length < 10 || phone.trim().length < 8} />
                </>
              )}

              {step === 'otp' && (
                <>
                  <Text style={styles.note} maxFontSizeMultiplier={scaleCap.label}>
                    Kode dikirim ke {phone} oleh Telegram. Masukkan 5 digit.
                  </Text>
                  <Field label="Kode OTP">
                    <TextInput
                      style={[inputStyle.mono, styles.inputMonoBig]}
                      value={code}
                      onChangeText={setCode}
                      keyboardType="number-pad"
                      maxLength={6}
                      placeholder="·····"
                      placeholderTextColor={color.textFaint}
                      maxFontSizeMultiplier={scaleCap.label}
                    />
                  </Field>
                  <PrimaryButton label="Verifikasi" onPress={submitCode} busy={busy} disabled={code.trim().length < 3} />
                  <GhostButton label="Ganti nomor" onPress={() => { setStep('api'); setError(null); }} />
                </>
              )}

              {step === 'password' && (
                <>
                  <Text style={styles.note} maxFontSizeMultiplier={scaleCap.label}>
                    Akun ini memakai two-step verification.
                  </Text>
                  <Field label="Password 2FA">
                    <TextInput
                      style={[inputStyle.base, styles.inputMono]}
                      value={password}
                      onChangeText={setPassword}
                      secureTextEntry
                      placeholder="password akun Telegram"
                      placeholderTextColor={color.textFaint}
                      maxFontSizeMultiplier={scaleCap.label}
                    />
                  </Field>
                  <PrimaryButton label="Buka gudang" onPress={submitPassword} busy={busy} disabled={password.length < 1} />
                </>
              )}

              {error && <Text style={styles.error} maxFontSizeMultiplier={scaleCap.label}>{error}</Text>}

              {Platform.OS === 'web' && step === 'api' && (
                <Pressable
                  onPress={() => setMode('qr')}
                  style={({ pressed }) => [styles.ghost, pressed && { opacity: 0.6 }]}
                >
                  <Text style={styles.ghostText} maxFontSizeMultiplier={scaleCap.label}>Pasangkan dengan HP (QR)</Text>
                </Pressable>
              )}
            </Card>
          )}

          <Text style={styles.foot} maxFontSizeMultiplier={scaleCap.label}>
            {'Sesi Telegram disimpan terenkripsi di servermu sendiri.\nAPI ID/Hash hanya dipakai untuk masuk ke akunmu.'}
          </Text>
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <View style={styles.field}>
      <Text style={styles.label} maxFontSizeMultiplier={scaleCap.label}>{label}</Text>
      {children}
      {hint && <Text style={styles.hint} maxFontSizeMultiplier={scaleCap.label}>{hint}</Text>}
    </View>
  );
}

function PrimaryButton({ label, onPress, busy, disabled }: { label: string; onPress: () => void; busy?: boolean; disabled?: boolean }) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || busy}
      accessibilityRole="button"
      style={({ pressed }) => [styles.primary, (disabled || busy) && styles.primaryDisabled, pressed && !disabled && styles.primaryPressed]}
    >
      {busy ? <ActivityIndicator color={color.onPrimary} /> : (
        <Text style={styles.primaryText} maxFontSizeMultiplier={scaleCap.label}>{label}</Text>
      )}
    </Pressable>
  );
}

function GhostButton({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.ghost, pressed && { opacity: 0.6 }]}>
      <Text style={styles.ghostText} maxFontSizeMultiplier={scaleCap.label}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  container: { flexGrow: 1, justifyContent: 'center', padding: space(6), maxWidth: 520, width: '100%', alignSelf: 'center' },
  header: { alignItems: 'center', marginBottom: space(8), gap: space(2) },
  logo: {
    width: 60, height: 60, borderRadius: 18, backgroundColor: color.primary,
    alignItems: 'center', justifyContent: 'center', marginBottom: space(2),
  },
  logoText: { color: color.onPrimary, fontSize: fontSize.lg, fontWeight: '700' },
  brand: { color: color.textPrimary, fontSize: fontSize.xl, fontWeight: '700', letterSpacing: -0.3 },
  sub: { color: color.textMuted, fontSize: fontSize.sm },
  panel: { padding: space(5), gap: space(2) },
  panelWide: { padding: space(3) },
  stepLabel: { color: color.textFaint, fontSize: fontSize.xs, marginBottom: space(4) },
  field: { marginBottom: space(4) },
  label: { fontSize: fontSize.xs, color: color.textMuted, marginBottom: space(1.5) },
  hint: { fontSize: fontSize.xs, color: color.textFaint, marginTop: space(1.5) },
  inputMono: { marginTop: 0 },
  inputMonoBig: { fontSize: fontSize.xl, letterSpacing: 8, textAlign: 'center' },
  note: { color: color.textMuted, fontSize: fontSize.sm, marginBottom: space(4) },
  primary: {
    backgroundColor: color.primary, borderRadius: radius.container, minHeight: 48,
    alignItems: 'center', justifyContent: 'center', marginTop: space(2),
  },
  primaryDisabled: { opacity: 0.45 },
  primaryPressed: { opacity: 0.85 },
  primaryText: { color: color.onPrimary, fontWeight: '700', fontSize: fontSize.base },
  ghost: { paddingVertical: space(3), alignItems: 'center', marginTop: space(2), minHeight: 44, justifyContent: 'center' },
  ghostText: { color: color.textMuted, fontSize: fontSize.sm },
  error: { color: color.red, fontSize: fontSize.sm, marginTop: space(4) },
  foot: { color: color.textFaint, fontSize: fontSize.xs, marginTop: space(8), lineHeight: 18, textAlign: 'center' },
});
