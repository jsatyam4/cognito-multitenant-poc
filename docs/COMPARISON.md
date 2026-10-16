# Comparison — Cognito column

Filled in from the live run on 15 Oct 2026 (real Cognito, `ap-south-1`, 9 tenants across 3 scenarios) and AWS documentation. The Keycloak column is left for the Keycloak half of the POC. Details and sources: [POC-GUIDE.md](../POC-GUIDE.md).

Scenarios: **A** shared pool, hosted login page · **B** pool per tenant, hosted login page · **C** pool per tenant, our own login page.

| Criteria | Cognito | Keycloak |
|---|---|---|
| **Tenant model used** | **Recommended: one user pool per tenant** (B, then C as tenants grow). The shared pool (A) blocks cross-tenant sign-in with a trigger, but **can't hold the same email in two tenants** (usernames are unique per pool) and can brand only ~6 tenants per pool. | |
| **Branding flexibility and limits** | Hosted page (A, B): logos, favicon, backgrounds, colours, radius, spacing, set **per app client**. **No custom HTML/CSS and no page text** (the app name goes in the logo). **20 styles per pool, not adjustable.** Logo must be 1:1–4:1 (found live). Change without deploy: ~0.9 s per tenant. Own page (C): full control including text and layout, edited by tenant admins in a theme editor, ~0.6 s, no deploy; we own the page's security. | |
| **Capturing additional user profile info** | Custom attributes: **max 50 per pool, permanent** (can't be removed or renamed), string/number. The POC uses `custom:department` and `custom:employee_id`, in the ID token. The hosted sign-up form can't collect custom fields; use an in-app profile step, admin entry at invite, or our own page. Rich profiles belong in your own database, keyed by `sub`. | |
| **Per-tenant URL or custom domain** | Hosted page: one free Cognito address per pool (`cpoc-acme-….amazoncognito.com`), or a custom domain, **but only 4 custom domains per region per account (not adjustable)**. Shared pool: one address for all. Own page (C): any number of tenant subdomains on our domain. The POC uses paths (`/t/acme`) because no domain was available. | |
| **Effort and time to add a tenant** | One command, no deploy, rolled back on failure. **Measured: pool per tenant 3.5–5.0 s, shared pool 2.6–5.8 s.** Manual extra with federation: add the new pool's redirect URI to the Entra/Google apps (automatable). | |
| **Token and claim customisation** | Pre-Token-Generation **V2** Lambda (Essentials+) adds claims to **both ID and access tokens** on every sign-in and refresh; verified live (`tenant_id`, `role`, `module`). Groups appear in tokens with no Lambda. Any custom logic during sign-in requires AWS Lambda. Access tokens carry `client_id`, not `aud`. | |
| **Quotas or scaling limits found** | 1,000 pools/region (10k max) · **20 branding styles/pool (fixed)** · **4 custom domains/region/account (fixed)** · 300 IdPs/pool · **request rates shared by all pools in the account** (sign-in 120/s, federation 25/s, adjustable) · 50 custom attributes · API Gateway's JWT authorizer takes one issuer, so pool per tenant needs JWT checks in code. | |
| **Hosting and ops effort** | Identity fully managed: no servers, database, patching or HA. Our part: 2 small trigger Lambdas, 1 registry table, onboarding scripts. Production adds SES for email, WAF, quota-increase requests and IdP redirect-URI automation; an own login page adds its UI and security work. | |
| **Estimated cost for 100 and 1,000 tenants** | Billed **per monthly active user, not per tenant**, so every scenario costs the same. Essentials: $0.015/MAU after 10,000 free; federated (Microsoft) $0.015 after 50 free. At 50 MAU/tenant, 20% Microsoft users, with API hosting: **100 tenants ≈ $16/month; 1,000 tenants ≈ $625/month** (≈ $340 on the Lite tier). | |
| **Overall pass count out of 8 requirements** | Live run: **pool per tenant 6/8 full pass** (hosted page and own page), **shared pool 4/8**; no unexpected failures. Partials: Microsoft/Google until credentials are added (all); no page text on the hosted page (A, B); password sign-in via SRP instead of the code flow (C); one login address (A). Fail: same email in the shared pool (A). | |

## Recommendation (Cognito)

If Cognito is chosen, use **one user pool per tenant**:

* It's the only model that fully meets requirement 1, including the same email in two tenants.
* Isolation comes from the pool itself, not from trigger code.
* Each tenant can have its own password, MFA and sign-in options.

Start with **Cognito's hosted login page**; it's ready on day one and AWS secures it. Move to **our own login page** when tenants need their own login address at scale, custom text or full design control. Users, tokens and the API stay the same.

The costs to manage:

* the 1,000-pool default per region (10k max) and account-wide request-rate limits; plan for several accounts or regions beyond a few thousand tenants.
* hosted-page limits: 4 custom domains per region per account, 20 styles per pool, no page text.
* per-tenant IdP redirect-URI registration, best automated.
* permanent custom attributes and no password-hash export (lock-in).

The shared pool fits only if one person never needs accounts in two tenants, one shared login address is acceptable, and few tenants need branding.

## How each requirement is shown

| # | Where in the POC |
|---|---|
| 1 | `npm run test:poc` R1 per scenario. Live: sign in to Acme's page with a Globex user (refused); jane exists in every own pool; jane couldn't be created twice in the shared pool. |
| 2 | `/t/<tenant>` → **Sign in**: the tenant's own Cognito host (B), the shared host (A), or our page `/t/<tenant>/login` (C) |
| 3 | Hosted: `scripts/lib/branding.ts`, `npm run rebrand` live. Own page: theme editor `/t/<tenant>/admin/branding` |
| 4 | 3 app clients per tenant (`scripts/lib/provision.ts`). Forgot password, logout (`/logout` or our page + revoke) and TOTP. |
| 5 | Hosted: `frontend/src/lib.ts` (oidc-client-ts, `code` + S256). Own page: `frontend/src/ownAuth.ts` (SRP) |
| 6 | `lambda/pre-token.ts`; claims table on the module page |
| 7 | `lambda/auth.ts`; API console buttons on the module page |
| 8 | `scripts/onboard.ts` → `.poc/onboarding/<tenant>.json` |
