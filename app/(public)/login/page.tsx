import { Suspense } from 'react';

import LoginClient from './LoginClient';

/**
 * The temporary-login flag is read on the server and passed down, so it never
 * ships as a NEXT_PUBLIC_* value the browser could read or a build could leak.
 */
export default function LoginPage() {
  return (
    <Suspense>
      <LoginClient tempMode={process.env.ALLOW_TEMP_LOGIN === '1'} />
    </Suspense>
  );
}
