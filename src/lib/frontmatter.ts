/**
 * Pure utilities for reading and writing YAML frontmatter in markdown files.
 * Always writes tags in inline array format: `tags: [a, b, c]`
 */

const FM_RE = /^---\r?\n([\s\S]*?)\r?\n---/;

interface ParsedFrontmatter {
  yaml: string;   // raw YAML between the --- delimiters
  body: string;   // everything after the closing ---  (includes leading newline if any)
}

function parse(content: string): ParsedFrontmatter | null {
  const match = content.match(FM_RE);
  if (!match) return null;
  return { yaml: match[1], body: content.slice(match[0].length) };
}

export function getFrontmatterField(content: string, field: string): string | null {
  const fm = parse(content);
  if (!fm) return null;
  const match = fm.yaml.match(new RegExp(`^${field}:\\s*(.+)$`, 'im'));
  if (!match) return null;
  return match[1].trim().replace(/^['"]|['"]$/g, '');
}

/** Extract tags from note content. Handles both inline and block list formats. */
export function getTagsFromContent(content: string): string[] {
  const fm = parse(content);
  if (!fm) return [];

  const lines = fm.yaml.split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const inlineMatch = line.match(/^tags:\s*\[([^\]]*)\]/);
    if (inlineMatch) {
      return inlineMatch[1]
        .split(',')
        .map(t => t.trim().replace(/^['"]|['"]$/g, ''))
        .filter(Boolean);
    }
    const blockMatch = line.match(/^tags:\s*$/);
    if (blockMatch) {
      const tags: string[] = [];
      i++;
      while (i < lines.length && /^[ \t]+-/.test(lines[i])) {
        tags.push(lines[i].replace(/^[ \t]+-\s*/, '').trim());
        i++;
      }
      return tags;
    }
    i++;
  }
  return [];
}

/** Rewrite (or add) the tags field in frontmatter, normalising to inline format. */
export function setTagsInContent(content: string, tags: string[]): string {
  const tagsLine = `tags: [${tags.join(', ')}]`;
  const fm = parse(content);

  if (!fm) {
    // No frontmatter at all — prepend a minimal block
    return `---\n${tagsLine}\n---\n${content}`;
  }

  // Rebuild the YAML line-by-line, replacing any existing tags: entry
  const lines = fm.yaml.split('\n');
  const newLines: string[] = [];
  let tagsHandled = false;
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (/^tags:/i.test(line)) {
      // Replace this line with our normalised tags line
      newLines.push(tagsLine);
      tagsHandled = true;
      i++;
      // Consume any following block-list items belonging to the old tags value
      while (i < lines.length && /^[ \t]+-/.test(lines[i])) i++;
    } else {
      newLines.push(line);
      i++;
    }
  }

  if (!tagsHandled) newLines.push(tagsLine);

  return `---\n${newLines.join('\n')}\n---${fm.body}`;
}

/** Add a tag if not already present. */
export function addTagToContent(content: string, tag: string): string {
  const current = getTagsFromContent(content);
  if (current.includes(tag)) return content;
  return setTagsInContent(content, [...current, tag]);
}

/** Remove a tag from the content. */
export function removeTagFromContent(content: string, tag: string): string {
  const current = getTagsFromContent(content);
  return setTagsInContent(content, current.filter(t => t !== tag));
}

/**
 * Ensure a `tags: []` line exists in the frontmatter.
 * - No frontmatter  → prepend `---\ntags: []\n---\n`
 * - Frontmatter without tags → append `tags: []` inside it
 * - Frontmatter already has tags → no-op (returns content unchanged)
 */
export function ensureTagsLine(content: string): string {
  const fm = parse(content);
  if (!fm) return `---\ntags: []\n---\n${content}`;
  if (/^tags:/im.test(fm.yaml)) return content;           // already present
  return `---\n${fm.yaml}\ntags: []\n---${fm.body}`;
}
