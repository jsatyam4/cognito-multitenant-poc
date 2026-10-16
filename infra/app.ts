import { App } from 'aws-cdk-lib';
import { readFileSync } from 'node:fs';
import { PlatformStack } from './platform-stack';

const cfg = JSON.parse(readFileSync('config/poc.config.json', 'utf8'));
const app = new App();

new PlatformStack(app, 'CognitoPocPlatform', {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: cfg.region },
  resourcePrefix: cfg.resourcePrefix,
  description: 'Cognito multi-tenant login POC — shared platform (tenants are NOT in this stack; they are created by scripts/onboard.ts)',
});
