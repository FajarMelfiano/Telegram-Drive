import { useCallback, useEffect, useState } from 'react';
import {
  Pressable, ScrollView, StyleSheet, Text, View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Link2, LogOut, Trash2, Unlink } from 'lucide-react-native';
import { Api, ApiError, type ActivityRow, type DeviceRow, type StatsResult, type WaStatus } from '../api';
import { useAuth } from '../auth';
import { WaQr } from '../components/WaQr';
import { color, fontSize, radius, scaleCap, space } from '../theme';
import { Card, Screen, ScreenHeader, SectionLabel } from '../components/ui';

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

const WA_STATE_LABEL: Record<string, { text: string; tint: string }> = {
  disconnected: { text: 'Terputus', tint: color.textFaint },
  connecting: { text: 'Menyambung…', tint: color.amber },
  qr_ready: { text: 'Siap pindai', tint: color.amber },
  linked: { text: 'Tertaut', tint: color.green },
  reconnecting: { text: 'Menyambung ulang', tint: color.amber },
  failed: { text: 'Gagal', tint: color.red },
};

const ACTIVITY_LABEL: Record<string, string> = {
  'file.uploaded': 'Unggah', 'file.renamed': 'Ubah nama', 'file.tagged': 'Tag',
  'file.deleted': 'Hapus', 'file.moved': 'Pindah', 'file.batch': 'Massal',
  'wa.file.saved': 'WhatsApp', 'wa.status': 'WA status', 'wa.skipped': 'WA lewat',
  'album.updated': 'Album', 'album.deleted': 'Album hapus',
};

/** Baris ledger: label kiri, nilai/aksi kanan. */
function Row({ label, value, tint, children }: {
  label: string; value?: string; tint?: string; children?: React.ReactNode;
}) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel} maxFontSizeMultiplier={scaleCap.label}>{label}</Text>
      <View style={styles.rowRight}>
        {value != null && (
          <Text style={[styles.rowValue, tint && { color: tint }]} numberOfLines={1} maxFontSizeMultiplier={scaleCap.label}>
            {value}
          </Text>
        )}
        {children}
      </View>
    </View>
  );
}

/** Baris perangkat: nama + waktu terakhir, aksi hapus 44dp. */
function DeviceRowView({ d, onRemove }: { d: DeviceRow; onRemove: () => void }) {
  return (
    <View style={styles.row}>
      <View style={styles.deviceMain}>
        <Text style={styles.rowLabel} maxFontSizeMultiplier={scaleCap.label}>{d.label}</Text>
        <Text style={styles.deviceSub} maxFontSizeMultiplier={scaleCap.label}>
          {new Date(d.lastSeenAt).toLocaleString()}
        </Text>
      </View>
      <Pressable
        onPress={onRemove}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel={`Hapus perangkat ${d.label}`}
        style={({ pressed }) => [styles.iconAction, pressed && { opacity: 0.6 }]}
      >
        <Trash2 size={16} strokeWidth={1.5} color={color.red} />
      </Pressable>
    </View>
  );
}

export function SettingsScreen({ onBack }: { onBack: () => void }) {
  const insets = useSafeAreaInsets();
  const { token, me, signOut } = useAuth();
  const [stats, setStats] = useState<StatsResult | null>(null);
  const [devices, setDevices] = useState<DeviceRow[]>([]);
  const [activity, setActivity] = useState<ActivityRow[]>([]);
  const [wa, setWa] = useState<WaStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [s, d, a, w] = await Promise.all([
        Api.stats(token), Api.devices(token), Api.activity(token, 20), Api.waStatus(token),
      ]);
      setStats(s); setDevices(d.devices); setActivity(a.activity); setWa(w);
    } catch (err) {
      setNotice(err instanceof ApiError ? `Gagal memuat (${err.code})` : 'Server tidak terjangkau.');
    }
  }, [token]);

  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => { void load(); }, [load]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const waConnect = async () => {
    setBusy(true); setNotice(null);
    try { setWa(await Api.waConnect(token)); }
    catch (err) { setNotice(err instanceof ApiError ? `Gagal (${err.code})` : 'Server tidak terjangkau.'); }
    finally { setBusy(false); }
  };
  const waDisconnect = async () => {
    setBusy(true); setNotice(null);
    try { setWa(await Api.waDisconnect(token)); }
    catch (err) { setNotice(err instanceof ApiError ? `Gagal (${err.code})` : 'Server tidak terjangkau.'); }
    finally { setBusy(false); }
  };

  const removeDevice = async (id: number) => {
    try { await Api.removeDevice(token, id); await load(); }
    catch (err) { setNotice(err instanceof ApiError ? `Gagal (${err.code})` : 'Server tidak terjangkau.'); }
  };

  const waInfo = wa ? (WA_STATE_LABEL[wa.state] ?? { text: wa.state, tint: color.textMuted }) : null;

  return (
    <Screen>
      <ScreenHeader title="Pengaturan" subtitle={me} onBack={onBack} />

      <ScrollView
        contentContainerStyle={{
          padding: space(4),
          paddingBottom: insets.bottom + 110,
          gap: space(5),
          maxWidth: 720,
          width: '100%',
          alignSelf: 'center',
        }}
      >
        {notice && <Text style={styles.notice} maxFontSizeMultiplier={scaleCap.label}>{notice}</Text>}

        <View>
          <SectionLabel>Penyimpanan</SectionLabel>
          <Card style={styles.card}>
            {stats ? (
              <>
                <Row label="Total file" value={String(stats.totalFiles)} />
                <Row label="Total ukuran" value={formatBytes(stats.totalBytes)} />
                {stats.byCategory.filter((c) => c.count > 0).slice(0, 6).map((c) => (
                  <Row key={c.key} label={c.key} value={`${c.count} · ${formatBytes(c.bytes)}`} />
                ))}
                {stats.bySource.filter((s) => s.count > 0).map((s) => (
                  <Row key={s.source} label={`Sumber ${s.source}`} value={String(s.count)} />
                ))}
              </>
            ) : <Row label="Memuat…" value="" />}
          </Card>
        </View>

        <View>
          <SectionLabel>WhatsApp</SectionLabel>
          <Card style={styles.card}>
            <Row
              label="Status"
              value={waInfo?.text}
              tint={waInfo?.tint}
            />
            {wa?.phone && <Row label="Nomor" value={wa.phone} />}
            {wa?.lastError && <Row label="Galat" value={wa.lastError} tint={color.red} />}
            <View style={styles.actionRow}>
              {wa?.state === 'linked' ? (
                <Pressable
                  onPress={() => void waDisconnect()}
                  disabled={busy}
                  accessibilityRole="button"
                  style={({ pressed }) => [styles.dangerBtn, busy && { opacity: 0.5 }, pressed && { opacity: 0.8 }]}
                >
                  <Unlink size={16} strokeWidth={1.5} color={color.onPrimary} />
                  <Text style={styles.dangerText} maxFontSizeMultiplier={scaleCap.label}>Putuskan</Text>
                </Pressable>
              ) : (
                <Pressable
                  onPress={() => void waConnect()}
                  disabled={busy}
                  accessibilityRole="button"
                  style={({ pressed }) => [styles.primaryBtn, busy && { opacity: 0.5 }, pressed && { opacity: 0.8 }]}
                >
                  <Link2 size={16} strokeWidth={1.5} color={color.onPrimary} />
                  <Text style={styles.primaryText} maxFontSizeMultiplier={scaleCap.label}>
                    {busy ? 'Menyambung…' : 'Sambungkan'}
                  </Text>
                </Pressable>
              )}
            </View>
            {wa?.state === 'qr_ready' && wa.qr && <WaQr data={wa.qr} />}
          </Card>
        </View>

        <View>
          <SectionLabel>Perangkat</SectionLabel>
          <Card style={styles.card}>
            {devices.length === 0 && <Row label="Belum ada perangkat" value="" />}
            {devices.map((d) => (
              <DeviceRowView key={d.id} d={d} onRemove={() => void removeDevice(d.id)} />
            ))}
          </Card>
        </View>

        <View>
          <SectionLabel>Aktivitas</SectionLabel>
          <Card style={styles.card}>
            {activity.length === 0 && <Row label="Belum ada aktivitas" value="" />}
            {activity.map((a) => (
              <View key={a.id} style={styles.row}>
                <Text style={styles.rowLabel} maxFontSizeMultiplier={scaleCap.label}>
                  {ACTIVITY_LABEL[a.type] ?? a.type}
                </Text>
                <Text style={styles.actTime} maxFontSizeMultiplier={scaleCap.label}>
                  {new Date(a.createdAt).toLocaleTimeString()}
                </Text>
              </View>
            ))}
          </Card>
        </View>

        <View style={styles.logoutWrap}>
          <Pressable
            onPress={() => void signOut()}
            accessibilityRole="button"
            style={({ pressed }) => [styles.logoutBtn, pressed && { opacity: 0.8 }]}
          >
            <LogOut size={16} strokeWidth={1.5} color={color.red} />
            <Text style={styles.logoutText} maxFontSizeMultiplier={scaleCap.label}>Keluar dari akun</Text>
          </Pressable>
        </View>
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  card: { padding: space(1), overflow: 'hidden' },
  notice: { color: color.red, fontSize: fontSize.xs },
  row: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingHorizontal: space(4), paddingVertical: space(3),
    borderBottomWidth: 1, borderBottomColor: color.hairline, gap: space(4), minHeight: 44,
  },
  rowLabel: { color: color.textMuted, fontSize: fontSize.sm, flexShrink: 1 },
  rowRight: { flexDirection: 'row', alignItems: 'center', gap: space(2), flexShrink: 1 },
  rowValue: { color: color.textPrimary, fontSize: fontSize.sm, textAlign: 'right', fontWeight: '600' },
  deviceMain: { flex: 1 },
  deviceSub: { color: color.textFaint, fontSize: fontSize.xs, marginTop: 2 },
  iconAction: {
    width: 44, height: 44, alignItems: 'center', justifyContent: 'center',
    borderRadius: radius.control,
  },
  actTime: { color: color.textFaint, fontSize: fontSize.xs },
  actionRow: { padding: space(3) },
  primaryBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: space(2),
    backgroundColor: color.primary, borderRadius: radius.control, minHeight: 44,
    paddingHorizontal: space(4), paddingVertical: space(3),
  },
  primaryText: { color: color.onPrimary, fontWeight: '700', fontSize: fontSize.sm },
  dangerBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: space(2),
    backgroundColor: color.red, borderRadius: radius.control, minHeight: 44,
    paddingHorizontal: space(4), paddingVertical: space(3),
  },
  dangerText: { color: color.onPrimary, fontWeight: '700', fontSize: fontSize.sm },
  logoutWrap: { marginTop: space(2) },
  logoutBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: space(2),
    borderWidth: 1, borderColor: color.hairline, borderRadius: radius.container,
    backgroundColor: color.surface, minHeight: 48,
  },
  logoutText: { color: color.red, fontSize: fontSize.sm, fontWeight: '600' },
});
