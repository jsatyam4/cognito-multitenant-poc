# Cognito multi-tenant login POC

> 📘 **Full guide** (requirements, design, findings, cost, comparison and runbook): [POC-GUIDE.md](POC-GUIDE.md)
> 🔗 **Shared documents** (architecture & cost, decisions, architect FAQ): [docs/SHARED-DOCS.md](docs/SHARED-DOCS.md)

Live demo for the *Cognito vs Keycloak POC — Requirements* doc (Cognito half), running against real Amazon Cognito. It covers:

* **3 scenarios side by side**, 3 tenants each:
  * **A · shared pool:** acme-shared, globex-shared, initech-shared. One pool, a `custom:tenant_id` tag on each user, Cognito's hosted login page.
  * **B · pool per tenant, hosted page:** acme, globex, initech. Cognito's branded login page per tenant.
  * **C · pool per tenant, own login page:** umbrella, hooli, stark. Our app hosts a themed login page, edited by tenant admins.
* 3 modules per tenant, each with **its own app client and its own login page**.
* One React app for every tenant: **OIDC Code + PKCE** on hosted pages, **SRP** sign-in on our own page.
* Pre-token **Lambda** trigger: `tenant_id`, `role` and `module` claims in both tokens; Microsoft/Google users limited to each tenant's email domains.
* A sample API that checks the JWT against the issuing pool's keys and **rejects tokens from the wrong tenant**.
* Tenants are created **by script, with no deploy**, in 2.6–5.8 s. Every step is timed.
* **Live results:** A 4/8, B 6/8, C 6/8 full pass (`results/results.md`); 56 offline tests.

```
Browser ──► Web app  localhost:5173  (one SPA, path-based tenants: /t/acme, /t/umbrella …)
   │            │ GET /public/tenants/{id}  → branding, theme, pool, client IDs
   │            ▼
   │      Sample API  localhost:8787 (Node or Docker) ── aws-jwt-verify (keys per pool)
   │                                     │                + tenant_id / client / path match
   │                                     ▼
   │                     DynamoDB tenant registry (AWS) ◄── scripts/onboard.ts (SDK)
   ▼
Cognito (AWS)
   ├─ A: shared pool   cpoc-shared-xxxx.auth…  hosted page, pre-auth trigger
   ├─ B: pool/tenant   cpoc-acme-xxxx.auth…    hosted page, branding per app client
   └─ C: pool/tenant   our page /t/umbrella/login, theme from the registry
        └─ Pre-token V2 Lambda (all pools) → tenant_id, role, module claims
```

**In AWS:** Cognito, 2 trigger Lambdas and 1 registry table (`npm run infra:up`). **Locally:** the app and the API.
**Per tenant (script, no deploy):** the user pool (or nothing, for shared tenants), login domain, groups, IdPs, 3 app clients, 3 branding styles (hosted page only) and the registry rows.

---

## Prerequisites (on your Mac)

* Node 20+ (`node -v`), and Docker Desktop if you want the API in a container
* A `.env` file (gitignored): `cp .env.example .env`, then fill in the AWS credentials, `AWS_ACCOUNT_ID` (scripts refuse to touch any other account) and `DEMO_PASSWORD`. Scripts read it without printing values.
* The region is set in `config/poc.config.json` (default `ap-south-1`, Mumbai).

## Configuration: `.env`

Everything account-specific or secret lives in `.env` (gitignored, never printed). Start from the template:

```bash
cp .env.example .env
```

| Variable | Used for |
|---|---|
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | AWS credentials for the POC account |
| `AWS_ACCOUNT_ID` | Account guard: scripts that create or delete resources stop if the credentials belong to another account |
| `DEMO_PASSWORD` | Password for every seeded demo user |
| `GITHUB_USER` / `GITHUB_TOKEN` (optional) | Pushing this repo with a token instead of the keychain |

To make `git push` read the GitHub token from `.env`, run once in the repo:

```bash
git config --local credential.helper ""
git config --local --add credential.helper '!f() { test "$1" = get || exit 0; e="$(git rev-parse --show-toplevel)/.env"; echo "username=$(sed -n "s/^GITHUB_USER=//p" "$e")"; echo "password=$(sed -n "s/^GITHUB_TOKEN=//p" "$e")"; }; f'
```

## What runs where

| In AWS (free tier) | On your machine |
|---|---|
| Cognito: user pools, login pages, app clients, branding, users | Web app (`localhost:5173`) |
| Lambda: `pre-token` and `pre-auth` triggers (Cognito can only call Lambda) | Sample API (`localhost:8787`, Node or Docker) |
| DynamoDB: one tenant-registry table (the triggers read it during sign-in) | Onboarding, admin and test scripts |

## Setup — about 10 minutes

```bash
cd ~/WebstormProjects/cognito-multitenant-poc

# 0. (optional) real inbox for "forgot password": config/poc.config.json → "demoEmailTemplate"

# 1. install
npm install
npm --prefix frontend install

# 2. AWS pieces besides Cognito: registry table, trigger Lambdas, their role and log groups (idempotent)
npm run infra:up

# 3. the 9 demo tenants, 3 per scenario, timed — A: *-shared · B: acme, globex, initech · C: umbrella, hooli, stark
npm run onboard:all

# 4. demo users (admin / user / jane-with-the-same-email in every tenant)
npm run seed

# 5. run the API and the app
docker compose up --build -d     # or: npm run api
npm run dev:frontend             # http://localhost:5173

# 6. the 8-requirement pass/fail suite, per scenario → results/results.md
npm run test:poc
```

**Free-tier guardrails:** at most 10 tenants and 5 users per tenant (`limits` in config), no SMS, no Plus tier. The 10th tenant slot is for onboarding `wayne` live: `npm run onboard -- --tenant wayne`.

**Teardown:** `npm run teardown` (tenants and pools), then `npm run infra:down` (Lambdas, role, table).

**Production deployment:** the CDK stack in `infra/` (`npm run deploy`) deploys the same API and triggers with CloudFront, API Gateway and DynamoDB.

Demo password for every seeded user: the `DEMO_PASSWORD` you set in `.env`. The emails are listed in `.poc/users.json`.

### Microsoft (Module 2) and Google (Module 3)

The code is fully wired up. Without credentials, Module 2 shows only username/password and Module 3 falls back to username/password, and the tenant page marks both as *credentials pending*. To turn them on, follow **[docs/IDP-SETUP.md](docs/IDP-SETUP.md)** (about 10 minutes each). It's easiest to do this before step 4.

## Everyday commands

| Command | What it does |
|---|---|
| `npm run onboard -- --tenant umbrella` | Onboards a **new tenant live** (pool model). Takes about 15–30 s, with no deploy. |
| `npm run onboard -- --tenant umbrella --model shared` | Same tenant, but inside the shared pool |
| `npm run rebrand -- --tenant acme --primary "#7B2FF7"` | Changes branding in place. No deploy; reload the login page to see it. |
| `npm run mfa -- --tenant acme --mode required` | Makes TOTP MFA required for one tenant (stretch goal) |
| `npm run seed` | (Re)seeds users for every tenant |
| `npm run test:poc` | Runs the automated requirement checks, per scenario |
| `npm run dev:frontend` | Runs the SPA on http://localhost:5173 (a registered sign-in callback) against the API on :8787 |
| `npm run api` / `docker compose up` | Runs the real sample API on http://localhost:8787 |
| `npm run infra:up` / `npm run infra:down` | Creates / removes the registry table, trigger Lambdas, role and log groups |
| `npm run offboard -- --tenant acme` | Removes one tenant |
| `npm run teardown` then `npm run infra:down` | Removes everything |

To add a tenant, drop a `tenants/<slug>.json` file (name, app name, colours, pattern, allowed email domains; for scenario C also `"loginMode": "own"` and a theme) and run `onboard`. The logo, favicon and background are generated from it.

## Testing without AWS

These need no AWS account or credentials. DynamoDB is stubbed and tokens are signed with a local key, but the real `lambda/*.ts` code runs.

| Command | What it does |
|---|---|
| `npm test` | 56 tests: JWT checks, tenant isolation (every cross-tenant pair), pre-token claims, pre-auth blocking, the Microsoft/Google email-domain allow-list, theme validation and saving, logo size rules, and the API over HTTP |
| `npm run local:api` | Runs the real API handler on http://localhost:8787 with 6 in-memory tenants (3 pool + 3 shared), no AWS |
| `curl localhost:8787/__local/tokens` | Prints user, admin and ID tokens for every local tenant, for trying the API by hand |
| `POC_API_URL=http://localhost:8787 npm run dev:frontend` | Runs the SPA against the local API: tenant directory and branded portals. **Sign-in can't work offline**, because the Cognito login hosts are fake. |

## Repo layout

```
config/            poc.config.json (incl. free-tier limits), idp.local.example.json
tenants/           A/B: acme, globex, initech · C: umbrella, hooli, stark · live demo: wayne
shared/            types.ts, branding-assets.ts (SVGs), theme.ts (validation)
lambda/            api.ts, auth.ts (JWT + tenant checks), pre-token.ts, pre-auth.ts, registry.ts
scripts/           infra-up/down, onboard, onboard-all, seed-users, rebrand, mfa, offboard, teardown,
                   api-server (real API), local-api (offline API), test-poc
scripts/lib/       provision, branding, registry, srp, env (.env loader), http-adapter
tests/             offline tests + fixtures
infra/             production CDK stack (CloudFront, API Gateway, Lambda, DynamoDB)
frontend/          React + Vite app (oidc-client-ts, amazon-cognito-identity-js)
docs/              COMPARISON.md, DEMO-SCRIPT.md, IDP-SETUP.md
results/           test-poc output
```

## POC-only shortcuts (not production)

* The app and API run on localhost. Production: the CDK stack in `infra/` (or Vercel).
* Emails go through Cognito's default sender, limited to 50/day. Production should use SES.
* Path-based tenant URLs are used because no domain was available. See POC-GUIDE §15 for custom-domain limits.
* The IAM user in `.env` has admin rights; reduce it after the POC. Full list: POC-GUIDE §20.
