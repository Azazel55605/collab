/** Lightweight hook point; importing it does not load the database workspace. */
let dirty: (profile?: string) => boolean = () => false;
export function registerDatabaseDraftGuard(guard: typeof dirty) {
  dirty = guard;
}
export function hasDatabaseDrafts(profile?: string) {
  return dirty(profile);
}
