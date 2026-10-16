# Cognito POC — shared documents

Live documents for the Cognito multi-tenant login POC. They're kept up to date as the POC changes; the repo docs ([POC-GUIDE.md](../POC-GUIDE.md), [COMPARISON.md](COMPARISON.md), [DEMO-SCRIPT.md](DEMO-SCRIPT.md)) cover the same ground in more technical detail.

| Document | What it covers | Read it if you want to… |
|---|---|---|
| [Architecture & Cost](https://claude.ai/artifact/CV1A8MNTpdhSGLiCw8apm5) | Architecture diagram, components, the three tenant models, sign-in and API flows (diagram), use cases, cost drivers, cost at 100 / 1,000 / 10,000 tenants, cheaper alternatives, known gaps | understand how it's built and what it will cost |
| [Decisions and Reasons](https://claude.ai/artifact/A4oSUvUR5Db6c1Wsu4hi3r) | Every decision taken, what was done and why, in a line or two each; Cognito limits found; live test results | know why it was built this way |
| [Architect FAQ](https://claude.ai/artifact/9nSgMNJeioZZYVpp9qrYjn) | ~95 likely questions with short answers: during-the-demo how and why, implementation choices, security, tokens, SSO, branding, scale, cost, operations, compliance, testing, what's not proven yet | prepare for, or get answers to, review questions |

## Results at a glance

Live run on real Amazon Cognito (`ap-south-1`, 15 Oct 2026), 9 tenants across three scenarios:

| Scenario | Requirements fully passed |
|---|---|
| A · Shared pool, Cognito-hosted login page | 4/8 |
| B · Pool per tenant, Cognito-hosted login page | 6/8 |
| C · Pool per tenant, our own login page | 6/8 |

Recommendation: one user pool per tenant, starting with Cognito's hosted login page and moving to our own login page as tenants grow.
