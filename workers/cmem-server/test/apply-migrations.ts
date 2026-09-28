// Applies migrations/ to the test D1 database before each test file
// (idempotent: already-applied migrations are skipped).
import { applyD1Migrations, env } from 'cloudflare:test';

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
