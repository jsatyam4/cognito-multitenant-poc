# Live demo script (~20 min)

**Before the meeting**
- `npm run infra:up`, `onboard:all`, `seed`, then start the API (`docker compose up -d`) and the app (`npm run dev:frontend`).
- Run `npm run test:poc` and open `results/results.md` in a tab.
- Use a private browser window, so no Cognito session cookies are left over. Keep a terminal open in the repo.
- Password for every demo user: `DEMO_PASSWORD` from `.env`. Emails are in `.poc/users.json` (`admin.<tenant>@example.com`, `user.<tenant>@example.com`, `jane.shared@example.com`).

## 1. One codebase, three scenarios (2 min)
* Open `http://localhost:5173`. The directory groups 9 tenants:
  * **A · shared pool:** acme-shared, globex-shared, initech-shared. One login address for all.
  * **B · own pool, hosted login:** acme, globex, initech. One login address each.
  * **C · own pool, own login page:** umbrella, hooli, stark. Our app hosts the login page.
* Open `/t/acme`, then `/t/globex`. Same app, different logo, colours, favicon and tab title, loaded from the registry at runtime.

## 2. Branded hosted login per tenant × module (3 min)
* On Acme (B), click **Sign in to Operations**. Point out the address bar (`cpoc-acme-….amazoncognito.com`) and the Acme branding.
* Go back and click **Sign in to Finance**: a different app client with its own page. With Microsoft credentials added, it shows the Microsoft button.
* Do the same on Globex: different branding, different login address.
* Open `/t/acme-shared` (A): the branding changes, but the address is the shared one.

## 3. Our own login page (3 min)
* Open `/t/umbrella` and click **Sign in to Operations**: it opens `/t/umbrella/login`, our page, with Umbrella's split layout and real welcome text.
* Open `/t/hooli/login`: a centred layout, rounded font and different text. All from the registry, with one codebase.
* Explain why it exists: no 4-domain limit, no 20-style limit, real page text, at the cost of owning the screens.

## 4. Tenant isolation (3 min)
* On **Acme's** Operations login page, enter **Globex's** admin email and the demo password → refused.
* On `/t/globex-shared`, sign in with `admin.acme@example.com` → refused by the pre-auth trigger (shared pool).
* Sign in to Acme and Globex as **jane** (the same email in both): two distinct `sub` values on the module pages.
* Show the seed output: jane **couldn't be created** in globex-shared or initech-shared. This is the key shared-pool finding.

## 5. Tokens + API (3 min)
* On the module page, the highlighted claims are `tenant_id`, `role`, `module` and `cognito:groups`, in both tokens.
* API console:
  * **GET /me** → 200
  * **Use my token on another tenant** → **403 wrong_tenant**
  * **Tampered token** → 401
  * **ID token as bearer** → 401
  * **/admin** as user → 403, then as admin → 200
* Optional: DevTools → Network → `/oauth2/token` shows `code_verifier` (PKCE) for hosted tenants.

## 6. Theme editor, no deploy (2 min)
* Sign in to Hooli as `admin.hooli@example.com`, then open **Edit login theme** (`/t/hooli/admin/branding`).
* Change the primary colour, layout and welcome title; the preview updates instantly.
* Try a yellow button with white text: the editor refuses it (contrast below 3:1). The API checks the same rules.
* **Save**, then open `/t/hooli/login`: live, no deploy.

## 7. Onboard a tenant live, no deploy (2 min)
```bash
npm run onboard -- --tenant wayne
```
* Read out the timed steps (about 4 s). Refresh the directory: **Wayne Enterprises** appears under C.
* `npm run seed` gives it users; sign in at `/t/wayne/login`.

## 8. Re-brand a hosted tenant live (1 min)
```bash
npm run rebrand -- --tenant acme --primary "#7B2FF7" --background "#F5EEFF"
```
* Reload Acme's login page: it's purple, in under a second, no deploy.

## 9. Results (1 min)
* `results/results.md`: pass/fail per requirement per scenario (A 4/8, B 6/8, C 6/8).
* `docs/COMPARISON.md`: the Cognito column and recommendation.

## Other flows to show if asked
* **Forgot password:** the hosted page and our page both send a code. Needs `demoEmailTemplate` set to a real inbox.
* **TOTP MFA:** `npm run mfa -- --tenant umbrella --mode required`, then sign in: our page shows the setup key and asks for the code. On a hosted tenant, Cognito's page shows its own setup screen. `--mode optional` switches back. With pool per tenant, MFA policy is **per tenant**.
* **Logout:** revokes the refresh token. Hosted tenants also call Cognito `/logout` to clear the login-domain session.
* **Single sign-on between modules (hosted):** untick *Always show the module's login page* and sign in to Finance after Operations. You're let straight in, because the session lives on the pool's login domain.
* **Microsoft from the wrong company:** with credentials added, a Microsoft user whose email domain isn't in the tenant's `allowedEmailDomains` is refused by the pre-token trigger.
