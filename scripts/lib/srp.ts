/**
 * Sign in with SRP (Secure Remote Password): the password is never sent, only a proof of it.
 * Same flow our own login page (scenario C) uses; replaces the old USER_PASSWORD_AUTH test shortcut.
 */
import { AuthenticationDetails, CognitoUser, CognitoUserPool, type ICognitoStorage } from 'amazon-cognito-identity-js';

class MemoryStorage implements ICognitoStorage {
  private data = new Map<string, string>();
  setItem(k: string, v: string) { this.data.set(k, v); }
  getItem(k: string) { return this.data.get(k) ?? null; }
  removeItem(k: string) { this.data.delete(k); }
  clear() { this.data.clear(); }
}

export interface Tokens { IdToken: string; AccessToken: string; RefreshToken: string }
export type LoginResult = { ok: true; tokens: Tokens } | { ok: false; error: string };

export function srpLogin(userPoolId: string, clientId: string, username: string, password: string): Promise<LoginResult> {
  const pool = new CognitoUserPool({ UserPoolId: userPoolId, ClientId: clientId, Storage: new MemoryStorage() });
  const user = new CognitoUser({ Username: username, Pool: pool, Storage: new MemoryStorage() });
  return new Promise((resolve) => {
    user.authenticateUser(new AuthenticationDetails({ Username: username, Password: password }), {
      onSuccess: (s) =>
        resolve({
          ok: true,
          tokens: { IdToken: s.getIdToken().getJwtToken(), AccessToken: s.getAccessToken().getJwtToken(), RefreshToken: s.getRefreshToken().getToken() },
        }),
      onFailure: (e: Error & { code?: string }) => resolve({ ok: false, error: `${e.code ?? e.name}: ${e.message}` }),
      newPasswordRequired: () => resolve({ ok: false, error: 'challenge NEW_PASSWORD_REQUIRED' }),
      mfaRequired: () => resolve({ ok: false, error: 'challenge SMS_MFA' }),
      totpRequired: () => resolve({ ok: false, error: 'challenge SOFTWARE_TOKEN_MFA' }),
      mfaSetup: () => resolve({ ok: false, error: 'challenge MFA_SETUP' }),
    });
  });
}
