export type TenantModel = 'pool' | 'shared';
/** hosted = Cognito managed login page (scenarios A/B); own = our app renders the login page (scenario C) */
export type LoginMode = 'hosted' | 'own';
export type ModuleId = 'module1' | 'module2' | 'module3';

export interface ModuleDef {
  id: ModuleId;
  name: string;
  description: string;
  /** Logical login methods the requirement asks for */
  methods: Array<'password' | 'microsoft' | 'google'>;
}

/** Requirement doc "App modules and login pages" */
export const MODULES: ModuleDef[] = [
  { id: 'module1', name: 'Module 1 · Operations', description: 'Username and password only', methods: ['password'] },
  { id: 'module2', name: 'Module 2 · Finance', description: 'Username and password, plus Microsoft (Entra ID)', methods: ['password', 'microsoft'] },
  { id: 'module3', name: 'Module 3 · Analytics', description: 'Google login (login method still to be confirmed)', methods: ['google'] },
];

export interface TenantBranding {
  primary: string;
  primaryText: string;
  pageBackground: string;
  accent: string;
  pattern: 'dots' | 'grid' | 'diagonal';
  logoSvg?: string;
  faviconSvg?: string;
}

/** Look of our own login page (scenario C). Edited live by tenant admins; no deploy. */
export interface TenantTheme {
  layout: 'centered' | 'split';
  font: 'system' | 'serif' | 'rounded';
  /** Corner radius in px for cards and buttons */
  radius: number;
  welcomeTitle: string;
  welcomeText: string;
  buttonLabel: string;
  footerText: string;
}

export interface TenantModuleClient {
  clientId: string;
  /** Cognito SupportedIdentityProviders on this app client */
  idps: string[];
  brandingId?: string;
  /** Requirement method that could not be wired (e.g. IdP creds missing) */
  missing?: string[];
}

export interface TenantRecord {
  tenantId: string;
  slug: string;
  displayName: string;
  appName: string;
  tagline: string;
  model: TenantModel;
  loginMode: LoginMode;
  region: string;
  userPoolId: string;
  issuer: string;
  /** e.g. https://cpoc-acme-1a2b.auth.ap-south-1.amazoncognito.com */
  loginDomain: string;
  modules: Record<ModuleId, TenantModuleClient>;
  branding: TenantBranding;
  theme?: TenantTheme;
  /**
   * Email domains whose Microsoft/Google users may sign in to this tenant.
   * Federated sign-in is refused when empty; ['*'] allows any domain.
   */
  allowedEmailDomains?: string[];
  status: 'active' | 'disabled';
  createdAt: string;
  onboardingSeconds?: number;
}

/** Subset served to the browser without auth */
export type PublicTenantConfig = Omit<TenantRecord, 'status' | 'allowedEmailDomains'>;

/**
 * Registry keys. One DynamoDB table, partition key `tenantId`:
 *   <tenantId>          the tenant record
 *   client#<clientId>   → which tenant + module owns an app client (triggers, API)
 *   pool#<userPoolId>   → which tenants live in a user pool (API issuer check)
 * Lookup rows let every runtime read be a single GetItem instead of a table scan.
 */
export const clientKey = (clientId: string) => `client#${clientId}`;
export const poolKey = (userPoolId: string) => `pool#${userPoolId}`;
export interface ClientLookup { tenantId: string; kind: 'client'; ref: string; module: ModuleId }
export interface PoolLookup { tenantId: string; kind: 'pool'; refs: Set<string> | string[] }
