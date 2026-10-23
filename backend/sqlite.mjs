import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MIGRATIONS = fileURLToPath(new URL('./migrations/', import.meta.url));

// 与 D1 的 d1_migrations 等价：按文件名顺序执行尚未应用的迁移，保证本地库与线上结构一致。
function migrate(sqlite) {
  sqlite.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_ms INTEGER NOT NULL)');
  const applied = new Set(sqlite.prepare('SELECT name FROM schema_migrations').all().map(row => row.name));
  const files = readdirSync(MIGRATIONS).filter(name => name.endsWith('.sql')).sort();
  for (const name of files) {
    if (applied.has(name)) continue;
    const sql = readFileSync(join(MIGRATIONS, name), 'utf8');
    sqlite.exec('BEGIN');
    try {
      sqlite.exec(sql);
      sqlite.prepare('INSERT INTO schema_migrations (name, applied_ms) VALUES (?, ?)').run(name, Date.now());
      sqlite.exec('COMMIT');
    } catch (error) { sqlite.exec('ROLLBACK'); throw error; }
  }
}

export function openDatabase(filename = process.env.DATABASE_PATH || fileURLToPath(new URL('../.data/booking.sqlite', import.meta.url))) {
  if (filename !== ':memory:') mkdirSync(dirname(resolve(filename)), { recursive: true });
  const sqlite = new DatabaseSync(filename);
  sqlite.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  migrate(sqlite);
  // Small adapter matching the D1 prepared-statement API; both runtimes use api.mjs.
  return {
    sqlite,
    prepare(sql) {
      const statement = sqlite.prepare(sql);
      const bound = (params = []) => ({
        bind: (...values) => bound(values),
        async first() { return statement.get(...params) || null; },
        async all() { return { results: statement.all(...params) }; },
        async run() { const result = statement.run(...params); return { success: true, meta: { changes: Number(result.changes) } }; },
      });
      return bound();
    },
    close() { sqlite.close(); },
  };
}
