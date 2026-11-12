export const SQLITE_EXTENSIONS = ['sqlite', 'sqlite3', 'db'];

export function isSqlitePath(path: string): boolean {
  return /\.(sqlite|sqlite3|db)$/i.test(path);
}
