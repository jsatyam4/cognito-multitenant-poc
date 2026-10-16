# Federated login setup (POC)

Recommendation for the POC: create **one Entra app registration** and **one Google OAuth client**, and register every tenant pool's redirect URI on each.

That keeps setup to about 20 minutes total, and it shows the real per-tenant cost of the pool-per-tenant model: **each new pool adds a redirect URI to every external IdP app**. In production you would automate this with the Microsoft Graph API, or move federation to the shared pool.

The URIs are deterministic, so you can register them **before** onboarding. Run `npm run idp-uris` after `npm run infra:up`, which prints one per tenant pool plus the shared pool. (They're also appended to `.poc/idp-redirect-uris.txt` during onboarding.) Each looks like:

```
https://cpoc-acme-1a2b3c.auth.ap-south-1.amazoncognito.com/oauth2/idpresponse
```

Put the credentials in `config/idp.local.json`. It is gitignored; copy it from `idp.local.example.json`.

---

## Microsoft Entra ID (Module 2)

Any Azure account works. A free Entra tenant comes with every Azure or Microsoft 365 developer account.

1. Go to **portal.azure.com → Microsoft Entra ID → App registrations → New registration**.
   * Name: `cognito-poc`
   * Supported account types: **Accounts in this organizational directory only** (single tenant).
   * Redirect URI: platform **Web**, paste the first `…/oauth2/idpresponse` URI.
2. **Authentication → Add URI** for each remaining pool URI (one per pool-per-tenant pool, plus one for the shared pool).
3. **Certificates & secrets → New client secret.** Copy the *Value* (not the ID).
4. **Overview:** copy the *Application (client) ID* and the *Directory (tenant) ID*.
5. Optional: **Token configuration → Add optional claim → ID → email**. The POC maps `preferred_username` (the UPN) to email, so this isn't required.
6. Add the values to `config/idp.local.json`:
   ```json
   "microsoft": { "clientId": "<application id>", "clientSecret": "<secret value>", "entraTenantId": "<directory id>" }
   ```
7. Create a test user in Entra (**Users → New user**) to sign in with.

The issuer used is `https://login.microsoftonline.com/<directory id>/v2.0`. Cognito needs a fixed issuer, so a single-tenant registration is the reliable choice. For "any customer's Entra tenant" in production, you'd create one IdP per customer tenant, with its own Entra directory ID. The limit is 300 IdPs per pool by default, adjustable to 1,000.

## Google (Module 3)

1. Go to **console.cloud.google.com → APIs & Services → OAuth consent screen**. Choose External, Testing mode, and add your Google account as a test user.
2. **Credentials → Create credentials → OAuth client ID → Web application.**
   * Authorized JavaScript origins: each `https://cpoc-…amazoncognito.com` host.
   * Authorized redirect URIs: each `…/oauth2/idpresponse` URI.
3. Copy the client ID and secret into `config/idp.local.json`:
   ```json
   "google": { "clientId": "…apps.googleusercontent.com", "clientSecret": "GOCSPX-…" }
   ```

## Allow the test users' email domains

Federated sign-in is **refused unless the user's email domain is in the tenant's `allowedEmailDomains`** (checked by the pre-token trigger). This stops anyone in a trusted directory, or any Google account, from signing in to every tenant.

* Edit `allowedEmailDomains` in `tenants/<slug>.json` before onboarding, e.g. `["yourcompany.onmicrosoft.com", "gmail.com"]`.
* `["*"]` allows any domain; use only for testing.
* For tenants already onboarded, update the `allowedEmailDomains` attribute on the tenant's row in the `cpoc-tenants` table; the triggers pick it up within 30 seconds.

## Apply

The IdPs are created when a tenant is onboarded. If you fill `config/idp.local.json` **before** `npm run onboard:all`, nothing else is needed. If the tenants already exist, re-create them:

```bash
npm run teardown && npm run onboard:all && npm run seed   # infra:up resources are kept
```

Redirect URIs use random-looking but stable prefixes, derived from your account and region, so re-onboarding produces the **same URIs**. Steps 1–2 above only need doing once.
