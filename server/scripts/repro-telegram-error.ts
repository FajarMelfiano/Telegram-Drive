/**
 * Repro diagnostik: paksa TeleprotoGateway.connect() + auth.SendCode
 * memakai apiId/apiHash tes (BOHONGAN — jangan pakai akun sungguhan).
 * Tujuan: membuktikan apakah transport MTProto dari mesin ini sehat
 * (Telegram akan membalas API_ID_INVALID = koneksi SUKSES),
 * atau gagal di level koneksi (timeout/socket = masalah jaringan/library).
 */
import tp from 'teleproto';
const { TelegramClient, Api } = tp;
const { StringSession } = tp.sessions;

const TEST_API_ID = 1;
const TEST_API_HASH = '00000000000000000000000000000000';

async function main() {
  console.log('[1] membuat client…');
  const client = new TelegramClient(new StringSession(''), TEST_API_ID, TEST_API_HASH, {
    connectionRetries: 5,
    timeout: 20,
  });

  console.log('[2] connect()…');
  const t0 = Date.now();
  try {
    await client.connect();
    console.log(`[2] SUKSES dalam ${Date.now() - t0}ms — transport MTProto sehat`);
  } catch (err) {
    console.error('[2] GAGAL connect:', err instanceof Error ? `${err.name}: ${err.message}` : err);
    process.exit(2);
  }

  console.log('[4] invoke auth.SendCode dengan kredensial tes…');
  try {
    await client.invoke(
      new Api.auth.SendCode({
        phoneNumber: '+628771293385',
        apiId: TEST_API_ID,
        apiHash: TEST_API_HASH,
        settings: new Api.CodeSettings({ allowAppHash: true }),
      }),
    );
    console.log('[4] tidak terduga: SendCode SUKSES dengan kredensial palsu?!');
  } catch (err) {
    // Ini BUKAN kegagalan — API_ID_INVALID justru BUKTI Telegram terjangkau.
    console.error('[4] RPC error dari Telegram:', err instanceof Error ? `${err.name}: ${err.message}` : err);
  }

  client.disconnect();
  process.exit(0);
}

main();
