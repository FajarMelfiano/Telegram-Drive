import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View,
} from 'react-native';
import { ArrowLeft, Link2, LogOut, Trash2, Unlink } from 'lucide-react-native';
import { Api, ApiError, type ActivityRow, type DeviceRow, type StatsResult, type WaStatus } from '../api';
import { useAuth } from '../auth';
import { WaQr } from '../components/WaQr';
import { color, font, fontSize, radius, space } from '../theme';

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

const WA_STATE_LABEL: Record<string, { text: string; tint: string }> = {
  disconnected: { text: 'TERPUTUS', tint: color.textFaint },
  connecting: { text: 'MENYAMBUNG…', tint: color.amber },
  qr_ready: { text: 'SIAP PINDAI', tint: color.amber },
  linked: { text: 'TERTAUT', tint: color.green },
  reconnecting: { text: 'MENYAMBUNG ULANG', tint: color.amber },
  failed: { text: 'GAGAL', tint: color.red },
};

const ACTIVITY_LABEL: Record<string, string> = {
  'file.uploaded': 'UNGGAH', 'file.renamed': 'UBAH NAMA', 'file.tagged': 'TAG',
  'file.deleted': 'HAPUS', 'file.moved': 'PINDAH', 'file.batch': 'MASSAL',
  'wa.file.saved': 'WHATSAPP', 'wa.status': 'WA STATUS', 'wa.skipped': 'WA LEWAT',
  'album.updated': 'ALBUM', 'album.deleted': 'ALBUM HAPUS',
};

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      <View style={styles.sectionBody}>{children}</View>
    </View>
  );
}

/** Baris ledger: label kiri mono, nilai/aksi kanan. Garis hairline pemisah. */
function Row({ label, value, tint, children }: {
  label: string; value?: string; tint?: string; children?: React.ReactNode;
}) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <View style={styles.rowRight}>
        {value != null && <Text style={[styles.rowValue, tint && { color: tint }]} numberOfLines={1}>{value}</Text>}
        {children}
      </View>
    </View>
  );
}

export function SettingsScreen({ onBack }: { onBack: () => void }) {
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

  useEffect(() => { void load(); }, [load]);

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

  const waInfo = wa ? (WA_STATE_LABEL[wa.state] ?? { text: wa.state.toUpperCase(), tint: color.textMuted }) : null;

  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <Pressable onPress={onBack} hitSlop={8} style={({ pressed }) => [styles.back, pressed && { opacity: 0.6 }]}>
          <ArrowLeft size={18} strokeWidth={1.5} color={color.textMuted} />
        </Pressable>
        <View>
          <Text style={styles.brand}>SETELAN</Text>
          <Text style={styles.who}>{me.toUpperCase()}</Text>
        </View>
      </View>

      <ScrollView contentContainerStyle={styles.scroll}>
        {notice && <Text style={styles.notice}>{notice}</Text>}

        <Section title="PENYIMPANAN">
          {stats ? (
            <>
              <Row label="TOTAL FILE" value={String(stats.totalFiles)} />
              <Row label="TOTAL UKURAN" value={formatBytes(stats.totalBytes)} />
              {stats.byCategory.filter((c) => c.count > 0).slice(0, 6).map((c) => (
                <Row key={c.key} label={c.key.toUpperCase()} value={`${c.count} · ${formatBytes(c.bytes)}`} />
              ))}
              {stats.bySource.filter((s) => s.count > 0).map((s) => (
                <Row key={s.source} label={`SUMBER ${s.source.toUpperCase()}`} value={String(s.count)} />
              ))}
            </>
          ) : <Row label="MEMUAT…" value="" />}
        </Section>

        <Section title="WHATSAPP">
          <Row label="STATUS" value={waInfo?.text} tint={waInfo?.tint} />
          {wa?.phone && <Row label="NOMOR" value={wa.phone} />}
          {wa?.lastError && <Row label="GALAT" value={wa.lastError} tint={color.red} />}
          <View style={styles.actionRow}>
            {wa?.state === 'linked' ? (
              <Pressable onPress={() => void waDisconnect()} disabled={busy}
                style={({ pressed }) => [styles.dangerBtn, busy && { opacity: 0.5 }, pressed && { opacity: 0.8 }]}>
                <Unlink size={14} strokeWidth={1.5} color={color.base} />
                <Text style={styles.dangerText}>PUTUSKAN</Text>
              </Pressable>
            ) : (
              <Pressable onPress={() => void waConnect()} disabled={busy}
                style={({ pressed }) => [styles.primaryBtn, busy && { opacity: 0.5 }, pressed && { opacity: 0.8 }]}>
                <Link2 size={14} strokeWidth={1.5} color={color.base} />
                <Text style={styles.primaryText}>{busy ? 'MENYAMBUNG…' : 'SAMBUNGKAN'}</Text>
              </Pressable>
            )}
          </View>
          {wa?.state === 'qr_ready' && wa.qr && <WaQr data={wa.qr} />}
        </Section>

        <Section title="PERANGKAT">
          {devices.length === 0 && <Row label="BELUM ADA PERANGKAT" value="" />}
          {devices.map((d) => (
            <View key={d.id} style={styles.row}>
              <View style={styles.deviceMain}>
                <Text style={styles.rowLabel}>{d.label}</Text>
                <Text style={styles.deviceSub}>{new Date(d.lastSeenAt).toLocaleString()}</Text>
              </View>
              <Pressable onPress={() => void removeDevice(d.id)} hitSlop={8}
                style={({ pressed }) => [styles.iconAction, pressed && { opacity: 0.6 }]}>
                <Trash2 size={15} strokeWidth={1.5} color={color.red} />
              </Pressable>
            </View>
          ))}
        </Section>

        <Section title="AKTIVITAS">
          {activity.length === 0 && <Row label="BELUM ADA AKTIVITAS" value="" />}
          {activity.map((a) => (
            <View key={a.id} style={styles.row}>
              <Text style={styles.rowLabel}>{ACTIVITY_LABEL[a.type] ?? a.type.toUpperCase()}</Text>
              <Text style={styles.actTime}>{new Date(a.createdAt).toLocaleTimeString()}</Text>
            </View>
          ))}
        </Section>

        <View style={styles.logoutWrap}>
          <Pressable onPress={() => void signOut()} style={({ pressed }) => [styles.logoutBtn, pressed && { opacity: 0.8 }]}>
            <LogOut size={15} strokeWidth={1.5} color={color.red} />
            <Text style={styles.logoutText}>KELUAR DARI AKUN</Text>
          </Pressable>
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.base },
  header: {
    flexDirection: 'row', alignItems: 'center', gap: space(3),
    paddingHorizontal: space(4), paddingVertical: space(3),
    borderBottomWidth: 1, borderBottomColor: color.hairline,
  },
  back: { width: 30, height: 30, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: color.hairline, borderRadius: radius.control },
  brand: { color: color.textPrimary, fontSize: fontSize.lg, fontWeight: '700', letterSpacing: 2 },
  who: { fontFamily: font.mono, fontSize: fontSize.xs, color: color.textFaint, letterSpacing: 1, marginTop: 2 },
  scroll: { padding: space(4), paddingBottom: space(10) },
  notice: { fontFamily: font.mono, fontSize: fontSize.xs, color: color.red, letterSpacing: 0.5, marginBottom: space(4) },
  section: { marginBottom: space(6) },
  sectionTitle: { fontFamily: font.mono, fontSize: fontSize.xs, color: color.amber, letterSpacing: 2, marginBottom: space(2) },
  sectionBody: { borderWidth: 1, borderColor: color.hairline },
  row: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingHorizontal: space(3), paddingVertical: space(3),
    borderBottomWidth: 1, borderBottomColor: color.hairline, gap: space(4), minHeight: 44,
  },
  rowLabel: { fontFamily: font.mono, fontSize: fontSize.xs, color: color.textMuted, letterSpacing: 1, flexShrink: 1 },
  rowRight: { flexDirection: 'row', alignItems: 'center', gap: space(2), flexShrink: 1 },
  rowValue: { fontFamily: font.mono, fontSize: fontSize.xs, color: color.textPrimary, textAlign: 'right' },
  deviceMain: { flex: 1 },
  deviceSub: { fontFamily: font.mono, fontSize: fontSize.xs, color: color.textFaint, marginTop: 2 },
  iconAction: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center' },
  actTime: { fontFamily: font.mono, fontSize: fontSize.xs, color: color.textFaint },
  actionRow: { paddingHorizontal: space(3), paddingVertical: space(3) },
  primaryBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: space(2),
    backgroundColor: color.amber, borderRadius: radius.control, paddingVertical: space(3),
  },
  primaryText: { color: color.base, fontWeight: '700', letterSpacing: 1.5, fontSize: fontSize.sm },
  dangerBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: space(2),
    backgroundColor: color.red, borderRadius: radius.control, paddingVertical: space(3),
  },
  dangerText: { color: color.base, fontWeight: '700', letterSpacing: 1.5, fontSize: fontSize.sm },
  logoutWrap: { marginTop: space(2) },
  logoutBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: space(2),
    borderWidth: 1, borderColor: color.hairline, borderRadius: radius.control, paddingVertical: space(3.5),
  },
  logoutText: { color: color.red, fontFamily: font.mono, fontSize: fontSize.xs, letterSpacing: 1.5 },
});
