import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";

/**
 * Real PostgreSQL for tests (the unique-constraint / concurrency guarantees can't be
 * faked). Uses TEST_DATABASE_URL if provided (e.g. `docker compose up db`), otherwise
 * boots a throwaway embedded Postgres — no Docker needed.
 */
let pg: EmbeddedPostgres | undefined;
let dir: string | undefined;

export async function setup() {
  let url = process.env.TEST_DATABASE_URL;
  if (!url) {
    dir = mkdtempSync(join(tmpdir(), "welcome-pg-"));
    const port = 54329;
    pg = new EmbeddedPostgres({
      databaseDir: dir,
      user: "test",
      password: "test",
      port,
      persistent: false,
      onLog: () => {},
      onError: () => {},
    });
    await pg.initialise();
    await pg.start();
    await pg.createDatabase("welcome_test");
    url = `postgresql://test:test@localhost:${port}/welcome_test`;
  }
  process.env.DATABASE_URL = url;
  execSync("npx prisma migrate deploy", { env: { ...process.env, DATABASE_URL: url }, stdio: "pipe" });
}

export async function teardown() {
  await pg?.stop();
  if (dir) rmSync(dir, { recursive: true, force: true });
}
