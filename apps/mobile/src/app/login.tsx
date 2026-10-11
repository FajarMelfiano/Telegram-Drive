import { Redirect, useRouter } from 'expo-router';
import { useAuth } from '../auth';
import { LoginScreen } from '../screens/LoginScreen';

export default function LoginRoute() {
  const { status, signIn } = useAuth();
  const router = useRouter();

  if (status === 'signedIn') return <Redirect href="/" />;

  return (
    <LoginScreen
      onLoggedIn={(token) => {
        void signIn(token).then(() => router.replace('/'));
      }}
    />
  );
}
