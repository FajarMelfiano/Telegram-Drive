import { Redirect } from 'expo-router';
import { BootScreen } from '../../components/BootScreen';
import { useAuth } from '../../auth';
import { ManifestScreen } from '../../screens/ManifestScreen';

export default function ManifestRoute() {
  const { status, token, me, signOut } = useAuth();

  if (status === 'loading') return <BootScreen />;
  if (status === 'signedOut' || !token) return <Redirect href="/login" />;

  return <ManifestScreen token={token} me={me} onLogout={signOut} />;
}
