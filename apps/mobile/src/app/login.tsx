import { Redirect, useRouter } from 'expo-router';
import { useAuth } from '../auth';
import { LoginScreen } from '../screens/LoginScreen';

export default function LoginRoute() {
  const { status, signIn } = useAuth();
  const router = useRouter();

  if (status === 'signedIn') return <Redirect href="/" />;

  return (
    <LoginScreen
      onLoggedIn={(token, extra) => {
        const refreshToken = typeof extra === 'string' ? extra : undefined;
        const session = typeof extra === 'string' ? undefined : extra;
        void signIn(token, refreshToken, session).then(() => router.replace('/'));
      }}
    />
  );
}
