import { mkdirSync } from "node:fs";
import { MIGRATIONS } from "./schema.js";

export type Row = Record<string, unknown>;

/** The small slice of a SQL client the server needs, so PostgreSQL and the embedded database are interchangeable. */
export interface Queryable {
  query<T extends Row = Row>(sql: string, params?: unknown[]): Promise<T[]>;
}

export interface Db extends Queryable {
  tx<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/** Embedded PostgreSQL (PGlite). For development and tests only: one process, one connection. */
export async function openEmbeddedDb(dataDir = ""): Promise<Db> {
  const { PGlite } = await import("@electric-sql/pglite");
  // The folder is made if it is not there yet: a first start needs nothing prepared.
  if (dataDir) mkdirSync(dataDir, { recursive: true });
  const pg = dataDir ? new PGlite(dataDir) : new PGlite();
  await pg.waitReady;
  const db: Db = {
    async query<T extends Row>(sql: string, params: unknown[] = []) {
      return (await pg.query<T>(sql, params)).rows;
    },
    tx: (fn) =>
      pg.transaction((tx) =>
        fn({
          async query<T extends Row>(sql: string, params: unknown[] = []) {
            return (await tx.query<T>(sql, params)).rows;
          },
        }),
      ) as Promise<never>,
    close: () => pg.close(),
  };
  await migrate(db);
  return db;
}

export async function openPostgresDb(connectionString: string): Promise<Db> {
  const { default: pg } = await import("pg");
  const pool = new pg.Pool({ connectionString });
  // Without a listener, an error on an idle connection (a database restart) crashes the process.
  pool.on("error", (error) => console.error("database connection error:", error.message));
  const db: Db = {
    async query<T extends Row>(sql: string, params: unknown[] = []) {
      return (await pool.query(sql, params)).rows as T[];
    },
    async tx(fn) {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const result = await fn({
          async query<T extends Row>(sql: string, params: unknown[] = []) {
            return (await client.query(sql, params)).rows as T[];
          },
        });
        await client.query("commit");
        return result;
      } catch (error) {
        // If the rollback itself fails, the original error is still the one to report.
        await client.query("rollback").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
  // One replica migrates at a time; the lock is released when the transaction ends.
  await db.tx(async (tx) => {
    await tx.query("select pg_advisory_xact_lock(727074001)");
    await migrate({ ...db, tx: (fn) => fn(tx) });
  });
  return db;
}

async function migrate(db: Db): Promise<void> {
  await db.query(
    "create table if not exists schema_migrations (version integer primary key, applied_at timestamptz not null default now())",
  );
  const applied = new Set(
    (await db.query<{ version: number }>("select version from schema_migrations")).map(
      (r) => r.version,
    ),
  );
  for (const [index, statements] of MIGRATIONS.entries()) {
    const version = index + 1;
    if (applied.has(version)) continue;
    await db.tx(async (tx) => {
      for (const statement of statements) await tx.query(statement);
      await tx.query("insert into schema_migrations (version) values ($1)", [version]);
    });
  }
}
