// Shared test DSN helpers: derive the Postgres base URL from the
// environment (FORGE_TEST_DATABASE_URL or DATABASE_URL) instead of
// hardcoding a machine-local username, so the suite runs anywhere.
//
// The base URL is a connection to the "postgres" admin DB — used to
// drop/create test databases. Test databases themselves are addressed as
// <base>/<test_db_name>.

/** Base DSN without a database name (…:5432/postgres). */
export function adminDsn(): string {
  const fromEnv = process.env.FORGE_TEST_DATABASE_URL ?? process.env.DATABASE_URL;
  if (fromEnv) {
    const url = new URL(fromEnv);
    url.pathname = "/postgres";
    return url.toString();
  }
  const user = process.env.USER ?? "postgres";
  return `postgresql://${user}@localhost:5432/postgres`;
}

/** DSN for a specific test database. */
export function testDbDsn(dbName: string): string {
  const fromEnv = process.env.FORGE_TEST_DATABASE_URL ?? process.env.DATABASE_URL;
  if (fromEnv) {
    const url = new URL(fromEnv);
    url.pathname = `/${dbName}`;
    return url.toString();
  }
  const user = process.env.USER ?? "postgres";
  return `postgresql://${user}@localhost:5432/${dbName}`;
}
