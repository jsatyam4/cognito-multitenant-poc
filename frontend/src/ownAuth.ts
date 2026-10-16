/**
 * Sign-in for our own login page (scenario C), talking to the tenant's Cognito pool directly.
 * SRP: the password never leaves the browser, only a proof of it. Each method returns the next
 * step the page should show, so the page is a simple state machine.
 */
import { AuthenticationDetails, CognitoUser, CognitoUserPool, type CognitoUserSession, type IAuthenticationCallback, type ICognitoStorage } from 'amazon-cognito-identity-js';

export interface OwnTokens { idToken: string; accessToken: string; refreshToken: string }
export type Step =
  | { kind: 'done'; tokens: OwnTokens }
  | { kind: 'newPassword' }
  | { kind: 'totp' }
  | { kind: 'mfaSetup'; secret: string; otpauth: string }
  | { kind: 'codeSent'; destination: string }
  | { kind: 'passwordReset' }
  | { kind: 'error'; message: string };

/** One message for wrong password, unknown user and blocked tenant, so the page can't be used to probe accounts. */
function friendly(e: { code?: string; name?: string; message?: string }): string {
  switch (e.code ?? e.name) {
    case 'NotAuthorizedException':
    case 'UserNotFoundException':
    case 'UserLambdaValidationException':
      return 'Incorrect email or password.';
    case 'CodeMismatchException':
      return 'That code is not right. Check your authenticator app and try again.';
    case 'ExpiredCodeException':
      return 'That code has expired. Request a new one.';
    case 'LimitExceededException':
    case 'TooManyRequestsException':
    case 'TooManyFailedAttemptsException':
      return 'Too many attempts. Please wait a few minutes and try again.';
    case 'InvalidPasswordException':
      return e.message ?? 'Password does not meet the requirements.';
    default:
      return 'Something went wrong. Please try again.';
  }
}

const tokensOf = (s: CognitoUserSession): OwnTokens => ({
  idToken: s.getIdToken().getJwtToken(),
  accessToken: s.getAccessToken().getJwtToken(),
  refreshToken: s.getRefreshToken().getToken(),
});

export class OwnAuth {
  private pool: CognitoUserPool;
  private storage: ICognitoStorage;
  private user?: CognitoUser;
  private email = '';

  constructor(userPoolId: string, clientId: string, private issuerLabel: string) {
    // Memory storage: tokens are handed to the app's session store, not left in localStorage
    const mem = new Map<string, string>();
    this.storage = { setItem: (k, v) => void mem.set(k, v), getItem: (k) => mem.get(k) ?? null, removeItem: (k) => void mem.delete(k), clear: () => mem.clear() };
    this.pool = new CognitoUserPool({ UserPoolId: userPoolId, ClientId: clientId, Storage: this.storage });
  }

  private userFor(email: string) {
    if (!this.user || this.email !== email) {
      this.email = email;
      this.user = new CognitoUser({ Username: email, Pool: this.pool, Storage: this.storage });
    }
    return this.user;
  }

  /** Callbacks shared by sign-in and every challenge response */
  private callbacks(resolve: (s: Step) => void): IAuthenticationCallback {
    return {
      onSuccess: (s) => resolve({ kind: 'done', tokens: tokensOf(s) }),
      onFailure: (e) => resolve({ kind: 'error', message: friendly(e) }),
      newPasswordRequired: () => resolve({ kind: 'newPassword' }),
      totpRequired: () => resolve({ kind: 'totp' }),
      mfaRequired: () => resolve({ kind: 'error', message: 'SMS codes are not enabled for this workspace.' }),
      mfaSetup: () =>
        this.user!.associateSoftwareToken({
          associateSecretCode: (secret) =>
            resolve({
              kind: 'mfaSetup',
              secret,
              otpauth: `otpauth://totp/${encodeURIComponent(`${this.issuerLabel}:${this.email}`)}?secret=${secret}&issuer=${encodeURIComponent(this.issuerLabel)}`,
            }),
          onFailure: (e) => resolve({ kind: 'error', message: friendly(e) }),
        }),
    };
  }

  signIn(email: string, password: string): Promise<Step> {
    const user = this.userFor(email.trim().toLowerCase());
    return new Promise((resolve) => user.authenticateUser(new AuthenticationDetails({ Username: this.email, Password: password }), this.callbacks(resolve)));
  }

  /** First sign-in after an admin invite: choose a permanent password */
  completeNewPassword(password: string): Promise<Step> {
    return new Promise((resolve) => this.user!.completeNewPasswordChallenge(password, {}, this.callbacks(resolve)));
  }

  /** Code from the authenticator app at sign-in */
  submitTotp(code: string): Promise<Step> {
    return new Promise((resolve) => this.user!.sendMFACode(code.trim(), this.callbacks(resolve), 'SOFTWARE_TOKEN_MFA'));
  }

  /** First code after scanning the secret: registers the authenticator and finishes sign-in */
  verifyTotpSetup(code: string): Promise<Step> {
    return new Promise((resolve) =>
      this.user!.verifySoftwareToken(code.trim(), 'Authenticator', {
        onSuccess: (s) => resolve({ kind: 'done', tokens: tokensOf(s) }),
        onFailure: (e) => resolve({ kind: 'error', message: friendly(e) }),
      }),
    );
  }

  forgotPassword(email: string): Promise<Step> {
    const user = this.userFor(email.trim().toLowerCase());
    return new Promise((resolve) =>
      user.forgotPassword({
        onSuccess: () => resolve({ kind: 'passwordReset' }),
        onFailure: (e) => resolve({ kind: 'error', message: friendly(e) }),
        // Same answer whether or not the account exists (pools use PreventUserExistenceErrors)
        inputVerificationCode: (d: { CodeDeliveryDetails?: { Destination?: string } }) =>
          resolve({ kind: 'codeSent', destination: d?.CodeDeliveryDetails?.Destination ?? 'your email' }),
      }),
    );
  }

  confirmForgotPassword(code: string, newPassword: string): Promise<Step> {
    return new Promise((resolve) =>
      this.user!.confirmPassword(code.trim(), newPassword, {
        onSuccess: () => resolve({ kind: 'passwordReset' }),
        onFailure: (e) => resolve({ kind: 'error', message: friendly(e) }),
      }),
    );
  }
}
