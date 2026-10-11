import { Redirect } from 'expo-router';
import { BootScreen } from '../../components/BootScreen';
import { useAuth } from '../../auth';
import { SearchScreen } from '../../screens/SearchScreen';

export default function SearchRoute() {
  const { status, token } = useAuth();

  if (status === 'loading') return <BootScreen />;
  if (status === 'signedOut' || !token) return <Redirect href="/login" />;

  return <SearchScreen token={token} />;
}
