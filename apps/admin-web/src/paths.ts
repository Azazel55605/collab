/**
 * Shortens a vault-relative path so it fits a fixed-width row.
 *
 * The file name is what identifies an entry, so it is kept whole whenever it
 * fits and only the leading folders are cut: `Projects/2026/Q3/…/report.md`.
 * When the name alone is longer than the budget it is shortened from the middle
 * instead, which keeps both its start and its extension readable. Callers are
 * expected to expose the untruncated value on hover.
 */
export function truncatePathForDisplay(path: string, maxLength = 44): string {
  if (maxLength <= 1 || path.length <= maxLength) return path;

  const separator = path.lastIndexOf('/');
  const name = separator >= 0 ? path.slice(separator + 1) : path;
  const directory = separator >= 0 ? path.slice(0, separator) : '';

  // "…/" costs two characters, so the name needs room for both to be worth
  // keeping any leading path at all.
  const directoryBudget = maxLength - name.length - 2;
  if (directory.length === 0 || directoryBudget <= 0) {
    return truncateMiddle(name, maxLength);
  }
  return `${directory.slice(0, directoryBudget)}…/${name}`;
}

/** Keeps the start and end of a value, replacing the middle with an ellipsis. */
export function truncateMiddle(value: string, maxLength: number): string {
  if (maxLength <= 1) return value.slice(0, Math.max(maxLength, 0));
  if (value.length <= maxLength) return value;
  const keep = maxLength - 1;
  const head = Math.ceil(keep / 2);
  const tail = keep - head;
  return tail > 0
    ? `${value.slice(0, head)}…${value.slice(value.length - tail)}`
    : `${value.slice(0, head)}…`;
}
