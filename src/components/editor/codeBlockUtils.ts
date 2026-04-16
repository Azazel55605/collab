import { LanguageDescription } from '@codemirror/language';
import { languages } from '@codemirror/language-data';

export interface CodeBlockLanguageOption {
  value: string;
  label: string;
  aliases: string[];
}

export interface DetectedCodeLanguage {
  language: string;
  confidence: 'high' | 'medium';
  reason: string;
}

export interface ParsedCodeBlockAtCursor {
  from: number;
  to: number;
  language: string;
  code: string;
}

const UNSORTED_CODE_BLOCK_LANGUAGE_OPTIONS: CodeBlockLanguageOption[] = [
  { value: '', label: 'Plain Text', aliases: ['plain text', 'text', 'plaintext', 'txt'] },
  { value: 'javascript', label: 'JavaScript', aliases: ['javascript', 'js'] },
  { value: 'typescript', label: 'TypeScript', aliases: ['typescript', 'ts'] },
  { value: 'jsx', label: 'JSX', aliases: ['jsx'] },
  { value: 'tsx', label: 'TSX', aliases: ['tsx'] },
  { value: 'json', label: 'JSON', aliases: ['json'] },
  { value: 'html', label: 'HTML', aliases: ['html'] },
  { value: 'css', label: 'CSS', aliases: ['css'] },
  { value: 'scss', label: 'SCSS', aliases: ['scss', 'sass'] },
  { value: 'markdown', label: 'Markdown', aliases: ['markdown', 'md'] },
  { value: 'bash', label: 'Bash', aliases: ['bash', 'sh', 'shell', 'zsh'] },
  { value: 'powershell', label: 'PowerShell', aliases: ['powershell', 'pwsh', 'ps1', 'psd1', 'psm1'] },
  { value: 'python', label: 'Python', aliases: ['python', 'py'] },
  { value: 'rust', label: 'Rust', aliases: ['rust', 'rs'] },
  { value: 'go', label: 'Go', aliases: ['go', 'golang'] },
  { value: 'java', label: 'Java', aliases: ['java'] },
  { value: 'kotlin', label: 'Kotlin', aliases: ['kotlin', 'kt'] },
  { value: 'swift', label: 'Swift', aliases: ['swift'] },
  { value: 'php', label: 'PHP', aliases: ['php'] },
  { value: 'ruby', label: 'Ruby', aliases: ['ruby', 'rb'] },
  { value: 'yaml', label: 'YAML', aliases: ['yaml', 'yml'] },
  { value: 'toml', label: 'TOML', aliases: ['toml'] },
  { value: 'sql', label: 'SQL', aliases: ['sql'] },
  { value: 'c', label: 'C', aliases: ['c'] },
  { value: 'cpp', label: 'C++', aliases: ['cpp', 'c++', 'cc', 'cxx'] },
  { value: 'csharp', label: 'C#', aliases: ['csharp', 'c#', 'cs'] },
];

export const CODE_BLOCK_LANGUAGE_OPTIONS: CodeBlockLanguageOption[] = [...UNSORTED_CODE_BLOCK_LANGUAGE_OPTIONS]
  .sort((a, b) => a.label.localeCompare(b.label));

const PLAIN_TEXT_OPTION = UNSORTED_CODE_BLOCK_LANGUAGE_OPTIONS.find((option) => option.value === '')!;

function normalizeLanguageName(value: string) {
  return value.trim().toLowerCase();
}

export function findLanguageOption(value: string) {
  const normalized = normalizeLanguageName(value);
  if (!normalized) return PLAIN_TEXT_OPTION;

  return CODE_BLOCK_LANGUAGE_OPTIONS.find((option) => (
    option.value === normalized || option.aliases.some((alias) => alias === normalized)
  )) ?? PLAIN_TEXT_OPTION;
}

export function getLanguageLabel(value: string) {
  return findLanguageOption(value).label;
}

export function renderMarkdownCodeBlock(language: string, code: string) {
  const normalizedLanguage = findLanguageOption(language).value;
  const trimmedCode = code.replace(/\n+$/, '');
  const fenceHead = normalizedLanguage ? `\`\`\`${normalizedLanguage}` : '```';
  return `${fenceHead}\n${trimmedCode}\n\`\`\``;
}

export function parseFenceInfoLanguage(info: string) {
  const token = info.trim().split(/\s+/, 1)[0] ?? '';
  return findLanguageOption(token).value;
}

function looksLikeJson(code: string) {
  const trimmed = code.trim();
  if (!trimmed || (!trimmed.startsWith('{') && !trimmed.startsWith('['))) return false;
  try {
    JSON.parse(trimmed);
    return true;
  } catch {
    return false;
  }
}

function detectByRegex(code: string) {
  const trimmed = code.trim();
  if (!trimmed) return null;

  const checks: Array<DetectedCodeLanguage | null> = [
    /(^|\n)\s*#include\s*<[^>]+>|(^|\n)\s*using\s+namespace\s+\w+|std::\w+|(^|\n)\s*(int|void|char|double|float)\s+main\s*\(|cout\s*<<|cin\s*>>/.test(trimmed)
      ? { language: /class\s+\w+\s*\{|template\s*</.test(trimmed) || /std::|cout\s*<</.test(trimmed) ? 'cpp' : 'c', confidence: 'high', reason: 'C/C++ syntax' } : null,
    /^(<!doctype html>|<html[\s>]|<body[\s>]|<div[\s>]|<span[\s>]|<main[\s>])/im.test(trimmed)
      ? { language: 'html', confidence: 'high', reason: 'HTML tags' } : null,
    /(^|\n)\s*(import\s.+from\s+['"]|export\s+(default|const|function|class)|const\s+\w+\s*=|function\s+\w+\s*\(|=>)/m.test(trimmed)
      ? { language: /<[A-Z][\w]*|<[a-z][^>]+>/.test(trimmed) ? 'jsx' : 'javascript', confidence: 'medium', reason: 'JS syntax' } : null,
    /(^|\n)\s*(interface\s+\w+|type\s+\w+\s*=|enum\s+\w+|implements\s+\w+|readonly\s+\w+)/m.test(trimmed)
      ? { language: /<[A-Z][\w]*|<[a-z][^>]+>/.test(trimmed) ? 'tsx' : 'typescript', confidence: 'high', reason: 'TypeScript syntax' } : null,
    /(^|\n)\s*def\s+\w+\(|(^|\n)\s*class\s+\w+[:(]|(^|\n)\s*from\s+\w+\s+import\s+|(^|\n)\s*if __name__ == ['"]__main__['"]:\s*|(^|\n)\s*print\s*\(|(^|\n)\s*elif\s+.+:\s*|(^|\n)\s*except\b/m.test(trimmed)
      ? { language: 'python', confidence: 'high', reason: 'Python syntax' } : null,
    /(^|\n)\s*(fn\s+\w+\(|let\s+mut\s+\w+|pub\s+(struct|enum|fn)|impl\s+\w+|use\s+[\w:]+::)/m.test(trimmed)
      ? { language: 'rust', confidence: 'high', reason: 'Rust syntax' } : null,
    /(^|\n)\s*package\s+\w+[\s\S]*?(^|\n)\s*func\s+\w+\(/m.test(trimmed)
      ? { language: 'go', confidence: 'high', reason: 'Go syntax' } : null,
    /(^|\n)\s*(public\s+class\s+\w+|private\s+\w+|System\.out\.println|static\s+void\s+main)/m.test(trimmed)
      ? { language: 'java', confidence: 'medium', reason: 'Java syntax' } : null,
    /(^|\n)\s*(SELECT|INSERT INTO|UPDATE\s+\w+\s+SET|DELETE FROM|CREATE TABLE)\b/i.test(trimmed)
      ? { language: 'sql', confidence: 'high', reason: 'SQL keywords' } : null,
    /(^|\n)\s*#!/.test(trimmed) || /(^|\n)\s*(echo\s+["'$]|if \[|then$|fi$|done$|export\s+\w+=)/m.test(trimmed)
      ? { language: 'bash', confidence: 'medium', reason: 'Shell syntax' } : null,
    /(^|\n)\s*(Get-[A-Z]\w+|Set-[A-Z]\w+|New-[A-Z]\w+|Write-(Host|Output|Error|Warning)|Test-Path|Join-Path|Import-Module|param\s*\(|\$[A-Za-z_]\w*\s*=|\[[A-Za-z_.]+\]\$[A-Za-z_]\w*)/m.test(trimmed)
      ? { language: 'powershell', confidence: 'high', reason: 'PowerShell cmdlets or variable syntax' } : null,
    /(^|\n)\s*#\s+.+|(^|\n)\s*[-*]\s+.+|(^|\n)\s*\d+\.\s+.+/.test(trimmed) && !/[;{}]/.test(trimmed)
      ? { language: 'markdown', confidence: 'medium', reason: 'Markdown structure' } : null,
    /(^|\n)\s*[\w-]+\s*:\s+.+/m.test(trimmed) && !/[{};]/.test(trimmed)
      ? { language: 'yaml', confidence: 'medium', reason: 'YAML pairs' } : null,
    /(^|\n)\s*\[[^\]]+\]\s*$/m.test(trimmed)
      ? { language: 'toml', confidence: 'medium', reason: 'TOML sections' } : null,
    /(^|\n)\s*[@$]\w+|(^|\n)\s*@mixin\s+|(^|\n)\s*@include\s+/m.test(trimmed)
      ? { language: 'scss', confidence: 'medium', reason: 'SCSS syntax' } : null,
    /[{][^}]*:[^;]+;/.test(trimmed) && /[.#]?[a-zA-Z][\w-]*\s*\{/.test(trimmed)
      ? { language: 'css', confidence: 'medium', reason: 'CSS rules' } : null,
    looksLikeJson(trimmed)
      ? { language: 'json', confidence: 'high', reason: 'Valid JSON' } : null,
  ];

  return checks.find(Boolean) ?? null;
}

export function detectCodeLanguage(code: string): DetectedCodeLanguage | null {
  return detectByRegex(code);
}

export async function loadCodeLanguageSupport(language: string) {
  const option = findLanguageOption(language);
  if (!option.value) return null;

  const alias = option.aliases[0] ?? option.value;
  const description = LanguageDescription.matchLanguageName(languages, alias, true);
  if (!description) return null;
  if (description.support) return description.support;

  try {
    return await description.load();
  } catch {
    return null;
  }
}
