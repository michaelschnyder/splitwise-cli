import { Command } from 'commander';
import { dump as yamlDump } from 'js-yaml';

// ── Name helper ───────────────────────────────────────────────────────────────

/** Safely join first + last name, omitting absent/null parts. */
export function formatName(
  user: { firstName?: string | null; lastName?: string | null } | null | undefined,
): string {
  if (!user) return '';
  return [user.firstName, user.lastName].filter(Boolean).join(' ');
}

// ── Output format ─────────────────────────────────────────────────────────────

export type OutputFormat = 'table' | 'json' | 'yaml';

/** Attach -o / --output to any command that produces structured output. */
export function addOutputOption(cmd: Command): Command {
  return cmd.option('-o, --output <format>', 'Output format: table | json | yaml', 'table');
}

export function getFormat(cmd: Command): OutputFormat {
  const fmt = (cmd.optsWithGlobals().output as string) ?? 'table';
  if (!['table', 'json', 'yaml'].includes(fmt)) {
    console.error(`Unknown format "${fmt}". Use: table, json, yaml`);
    process.exit(1);
  }
  return fmt as OutputFormat;
}

/** Render an array of flat records in the requested format. */
export function render(rows: Record<string, unknown>[], format: OutputFormat): void {
  if (rows.length === 0) {
    if (format === 'json') { console.log('[]'); return; }
    if (format === 'yaml') { console.log('[]'); return; }
    console.log('(no results)');
    return;
  }
  switch (format) {
    case 'json':
      console.log(JSON.stringify(rows, null, 2));
      break;
    case 'yaml':
      console.log(yamlDump(rows, { lineWidth: -1 }));
      break;
    case 'table':
      console.table(rows);
      break;
  }
}

/** Render a single object (e.g. for `get` / `whoami`). */
export function renderOne(record: Record<string, unknown>, format: OutputFormat): void {
  if (format === 'table') {
    for (const [k, v] of Object.entries(record)) {
      console.log(`${k.padEnd(16)} ${String(v)}`);
    }
  } else {
    render([record], format);
  }
}

export function renderEmptyList(format: OutputFormat): void {
  if (format === 'json') { console.log('[]'); }
  else if (format === 'yaml') { console.log('[]'); }
  else { console.log('(no results)'); }
}

// ── Unicode-aware display-width helpers ───────────────────────────────────────

/**
 * Returns the terminal display width of a string, counting wide characters
 * (emoji, CJK, etc.) as 2 and zero-width characters as 0.
 */
export function visualWidth(str: string): number {
  let width = 0;
  for (const char of str) {
    const cp = char.codePointAt(0) ?? 0;
    if (
      cp === 0 ||
      (cp >= 0x200B && cp <= 0x200F) || // zero-width space / joiners
      cp === 0xFE0F ||                   // variation selector-16 (emoji style)
      cp === 0xFEFF                      // BOM
    ) {
      // zero-width — contributes nothing
    } else if (
      cp > 0xFFFF ||                          // astral (most emoji, e.g. 🍕 0x1F355)
      (cp >= 0x1100 && cp <= 0x115F) ||       // Hangul Jamo
      (cp >= 0x2E80 && cp <= 0x303E) ||       // CJK Radicals / Kangxi
      (cp >= 0x3040 && cp <= 0x33FF) ||       // Japanese kana + CJK compatibility
      (cp >= 0x3400 && cp <= 0x4DBF) ||       // CJK Extension A
      (cp >= 0x4E00 && cp <= 0x9FFF) ||       // CJK Unified
      (cp >= 0xAC00 && cp <= 0xD7AF) ||       // Hangul Syllables
      (cp >= 0xF900 && cp <= 0xFAFF) ||       // CJK Compatibility Ideographs
      (cp >= 0xFF00 && cp <= 0xFF60) ||       // Fullwidth Latin / Katakana
      (cp >= 0xFFE0 && cp <= 0xFFE6)          // Fullwidth signs
    ) {
      width += 2;
    } else {
      width += 1;
    }
  }
  return width;
}

/** Left-pad str to visual `width` (for right-alignment). */
export function padStartVisual(str: string, width: number): string {
  return ' '.repeat(Math.max(0, width - visualWidth(str))) + str;
}

/** Right-pad str to visual `width` (for left-alignment). */
export function padEndVisual(str: string, width: number): string {
  return str + ' '.repeat(Math.max(0, width - visualWidth(str)));
}
