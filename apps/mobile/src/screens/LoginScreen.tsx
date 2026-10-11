import { useState } from 'react';
import {
  ActivityIndicator, KeyboardAvoidingView, Platform, Pressable,
  ScrollView, StyleSheet, Text, TextInput, View,
} from 'react-native';
import { Api, ApiError } from '../api';
import { color, font, fontSize, radius, space } from '../theme';

type Step = 'api' | 'phone' | 'otp' | 'password';

const ERROR_TEXT: Record<string, string> = {
  PHONE_NUMBER_INVALID: 'Nomor tidak dikenal Telegram. Pakai format +62…',
  PHONE_CODE_INVALID: 'Kode salah atau kedaluwarsa. Cek lagi dari Telegram.',
  PASSWORD_INVALID: 'Password 2FA salah.',
  API_INVALID: 'API ID atau Hash ditolak Telegram. Periksa di my.telegram.org.',
  FLOOD_WAIT: 'Telegram minta jeda. Coba lagi nanti.',
  TELEGRAM_ERROR: 'Koneksi ke Telegram gagal. Coba lagi.',
};

/** Layar masuk: API ID/Hash → nomor → OTP → (opsional) password 2FA. */
export function LoginScreen({ onLoggedIn }: { onLoggedIn: (token: string, refreshToken?: string) => void }) {
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
      if (res.token) onLoggedIn(res.token, res.refreshToken);
    } catch (err) { showError(err); } finally { setBusy(false); }
  };

  const submitPassword = async () => {
    if (!requestId) return;
    setBusy(true); setError(null);
    try {
      const res = await Api.password(requestId, password, null);
      onLoggedIn(res.token, res.refreshToken);
    } catch (err) { showError(err); } finally { setBusy(false); }
  };

  const stepNo = step === 'api' ? 1 : step === 'phone' ? 2 : step === 'otp' ? 2 : 2;

  return (
    <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
        <View style={styles.header}>
          <Text style={styles.brand}>TELEGRAM DRIVE</Text>
          <Text style={styles.sub}>GUDANG PRIBADI · MANIFEST OTOMATIS</Text>
        </View>

        <View style={styles.panel}>
          <Text style={styles.stepLabel}>LANGKAH {stepNo} · {step === 'api' ? 'KREDENSIAL API' : step === 'phone' ? 'NOMOR TELEPON' : step === 'otp' ? 'KODE OTP' : 'PASSWORD 2FA'}</Text>

          {step === 'api' && (
            <>
              <Field label="API ID" hint="my.telegram.org → API development tools">
                <TextInput style={styles.inputMono} value={apiId} onChangeText={setApiId}
                  keyboardType="number-pad" placeholder="123456" placeholderTextColor={color.textFaint} />
              </Field>
              <Field label="API HASH" hint="32 karakter hex — jangan bagikan ke siapa pun">
                <TextInput style={styles.inputMono} value={apiHash} onChangeText={setApiHash}
                  autoCapitalize="none" placeholder="a1b2c3…" placeholderTextColor={color.textFaint} secureTextEntry />
              </Field>
              <Field label="NOMOR TELEPON" hint="Format internasional, contoh +6281234567890">
                <TextInput style={styles.inputMono} value={phone} onChangeText={setPhone}
                  keyboardType="phone-pad" placeholder="+62…" placeholderTextColor={color.textFaint} />
              </Field>
              <PrimaryButton label="KIRIM KODE OTP" onPress={submitApi} busy={busy}
                disabled={!apiId || apiHash.trim().length < 10 || phone.trim().length < 8} />
            </>
          )}

          {step === 'otp' && (
            <>
              <Text style={styles.note}>Kode dikirim ke {phone} oleh Telegram. Masukkan 5 digit.</Text>
              <Field label="KODE OTP">
                <TextInput style={styles.inputMonoBig} value={code} onChangeText={setCode}
                  keyboardType="number-pad" maxLength={6} placeholder="·····" placeholderTextColor={color.textFaint} />
              </Field>
              <PrimaryButton label="VERIFIKASI" onPress={submitCode} busy={busy} disabled={code.trim().length < 3} />
              <GhostButton label="GANTI NOMOR" onPress={() => { setStep('api'); setError(null); }} />
            </>
          )}

          {step === 'password' && (
            <>
              <Text style={styles.note}>Akun ini memakai two-step verification.</Text>
              <Field label="PASSWORD 2FA">
                <TextInput style={styles.input} value={password} onChangeText={setPassword}
                  secureTextEntry placeholder="password akun Telegram" placeholderTextColor={color.textFaint} />
              </Field>
              <PrimaryButton label="BUKA GUDANG" onPress={submitPassword} busy={busy} disabled={password.length < 1} />
            </>
          )}

          {error && <Text style={styles.error}>{error}</Text>}
        </View>

        <Text style={styles.foot}>
          Sesi Telegram disimpan terenkripsi di servermu sendiri.{'\n'}API ID/Hash hanya dipakai untuk masuk ke akunmu.
        </Text>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      {children}
      {hint && <Text style={styles.hint}>{hint}</Text>}
    </View>
  );
}

function PrimaryButton({ label, onPress, busy, disabled }: { label: string; onPress: () => void; busy?: boolean; disabled?: boolean }) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || busy}
      style={({ pressed }) => [styles.primary, (disabled || busy) && styles.primaryDisabled, pressed && !disabled && styles.primaryPressed]}
    >
      {busy ? <ActivityIndicator color={color.base} /> : <Text style={styles.primaryText}>{label}</Text>}
    </Pressable>
  );
}

function GhostButton({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.ghost, pressed && { opacity: 0.6 }]}>
      <Text style={styles.ghostText}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: color.base },
  container: { flexGrow: 1, justifyContent: 'center', padding: space(6), maxWidth: 520, width: '100%', alignSelf: 'center' },
  header: { marginBottom: space(8) },
  brand: { color: color.textPrimary, fontSize: fontSize.xxl, fontWeight: '700', letterSpacing: 2 },
  sub: { fontFamily: font.mono, fontSize: fontSize.xs, color: color.amber, letterSpacing: 2, marginTop: space(1.5) },
  panel: { borderWidth: 1, borderColor: color.hairline, backgroundColor: color.surface, padding: space(5) },
  stepLabel: { fontFamily: font.mono, fontSize: fontSize.xs, color: color.textFaint, letterSpacing: 1.5, marginBottom: space(5) },
  field: { marginBottom: space(4) },
  label: { fontSize: fontSize.xs, color: color.textMuted, letterSpacing: 1, marginBottom: space(1.5) },
  hint: { fontFamily: font.mono, fontSize: fontSize.xs, color: color.textFaint, marginTop: space(1.5) },
  input: {
    borderWidth: 1, borderColor: color.hairline, borderRadius: radius.control,
    backgroundColor: color.base, color: color.textPrimary, paddingHorizontal: space(3), paddingVertical: space(3), fontSize: fontSize.base,
  },
  inputMono: {
    borderWidth: 1, borderColor: color.hairline, borderRadius: radius.control,
    backgroundColor: color.base, color: color.textPrimary, paddingHorizontal: space(3), paddingVertical: space(3),
    fontFamily: font.mono, fontSize: fontSize.base,
  },
  inputMonoBig: {
    borderWidth: 1, borderColor: color.hairline, borderRadius: radius.control,
    backgroundColor: color.base, color: color.amber, paddingHorizontal: space(3), paddingVertical: space(3),
    fontFamily: font.mono, fontSize: fontSize.xl, letterSpacing: 8,
  },
  note: { color: color.textMuted, fontSize: fontSize.sm, marginBottom: space(4) },
  primary: {
    backgroundColor: color.amber, borderRadius: radius.control, paddingVertical: space(3.5),
    alignItems: 'center', marginTop: space(2),
  },
  primaryDisabled: { backgroundColor: color.amberDim },
  primaryPressed: { opacity: 0.85 },
  primaryText: { color: color.base, fontWeight: '700', letterSpacing: 1.5, fontSize: fontSize.sm },
  ghost: { paddingVertical: space(3), alignItems: 'center', marginTop: space(2) },
  ghostText: { color: color.textMuted, fontSize: fontSize.sm, letterSpacing: 1 },
  error: { color: color.red, fontSize: fontSize.sm, marginTop: space(4) },
  foot: { fontFamily: font.mono, fontSize: fontSize.xs, color: color.textFaint, marginTop: space(8), lineHeight: 18 },
});
