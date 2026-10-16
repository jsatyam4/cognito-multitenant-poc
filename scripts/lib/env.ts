/**
 * Loads AWS credentials from .env (gitignored) without printing them.
 * Uses the standard AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY names, which the AWS SDK reads.
 * Imported first by scripts/lib/common.ts so every AWS SDK client sees the credentials.
 */
import { existsSync } from 'node:fs';

if (existsSync('.env')) process.loadEnvFile('.env');
