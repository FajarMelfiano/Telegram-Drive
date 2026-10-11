import { Redirect, useRouter } from 'expo-router';
import { BootScreen } from '../components/BootScreen';
import { useAuth } from '../auth';
import { AlbumScreen } from '../screens/AlbumScreen';

export default function AlbumRoute() {
  const { status, token } = useAuth();
  const router = useRouter();

  if (status === 'loading') return <BootScreen />;
  if (status === 'signedOut' || !token) return <Redirect href="/login" />;

  return <AlbumScreen token={token} onBack={() => router.replace('/')} />;
}
