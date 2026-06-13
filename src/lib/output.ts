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
  return cmd.option('-o, --output <format>', 'Output format: table | json | yaml');
}

export function getFormat(cmd: Command): OutputFormat {
  const fmt = (cmd.optsWithGlobals().output as string) ?? 'table';
  if (!['table', 'json', 'yaml'].includes(fmt)) {
    console.error(`Unknown format "${fmt}". Use: table, json, yaml`);
    process.exit(1);
  }
  return fmt as OutputFormat;
}

/** True when running with implicit table output (no explicit -o/--output). */
export function isTuiDefault(cmd: Command): boolean {
  const output = cmd.optsWithGlobals().output as string | undefined;
  return (output === undefined || output === null) && getFormat(cmd) === 'table';
}

type TuiColor = 'cyan' | 'green' | 'red' | 'yellow' | 'dim';

const ANSI: Record<TuiColor, string> = {
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  dim: '\x1b[2m',
};

const ANSI_RESET = '\x1b[0m';

function supportsColor(): boolean {
  return process.stdout.isTTY && process.env.NO_COLOR === undefined;
}

export function colorize(text: string, color: TuiColor): string {
  if (!supportsColor()) return text;
  return `${ANSI[color]}${text}${ANSI_RESET}`;
}

export type TuiProgress = {
  start: (message: string) => void;
  stop: (finalMessage?: string) => void;
};

export function createTuiProgress(enabled: boolean): TuiProgress {
  const canRender = enabled && process.stdout.isTTY;
  let active = false;

  const clearLine = () => {
    if (!canRender || !active) return;
    process.stdout.write('\r\x1b[2K');
    active = false;
  };

  return {
    start: (message: string) => {
      if (!canRender) return;
      const line = colorize(message, 'dim');
      process.stdout.write(`\r${line}`);
      active = true;
    },
    stop: (finalMessage?: string) => {
      if (!canRender) {
        if (finalMessage) console.log(finalMessage);
        return;
      }
      clearLine();
      if (finalMessage) process.stdout.write(`${finalMessage}\n`);
    },
  };
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

export type TuiListRenderOptions = {
  intro: string;
  source: string;
  startedAt?: number;
};

function headerLabel(key: string): string {
  return key
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Render list-like output in the shared TUI style:
 * blank + intro, blank + table, blank + one-line summary footer.
 */
export function renderTuiList(rows: Record<string, unknown>[], options: TuiListRenderOptions): void {
  const startedAt = options.startedAt ?? Date.now();
  const tableGap = '   ';

  console.log('');
  console.log(colorize(options.intro, 'cyan'));

  if (rows.length === 0) {
    const elapsed = Date.now() - startedAt;
    console.log('\n(no results)');
    console.log(colorize(`\n• 0 item(s) | ${elapsed} ms | source: ${options.source}`, 'dim'));
    return;
  }

  const keys = Object.keys(rows[0]);
  const labels = keys.map(headerLabel);
  const widths = keys.map((k, i) =>
    Math.max(labels[i].length, ...rows.map((r) => visualWidth(String(r[k] ?? '')))),
  );

  console.log('');
  process.stdout.write(
    labels.map((label, i) => padEndVisual(label, widths[i])).join(tableGap) + '\n',
  );
  process.stdout.write(widths.map((w) => '─'.repeat(w)).join(tableGap) + '\n');

  for (const row of rows) {
    process.stdout.write(
      keys.map((k, i) => padEndVisual(String(row[k] ?? ''), widths[i])).join(tableGap) + '\n',
    );
  }

  const elapsed = Date.now() - startedAt;
  console.log(colorize(`\n• ${rows.length} item(s) | ${elapsed} ms | source: ${options.source}`, 'dim'));
}

// ── Unicode-aware display-width helpers ───────────────────────────────────────

/**
 * Returns the terminal display width of a string, counting wide characters
 * (emoji, CJK, etc.) as 2 and zero-width characters as 0.
 */
export function visualWidth(str: string): number {
  const stripped = str.replace(/\x1b\[[0-9;]*m/g, '');
  let width = 0;
  for (const char of stripped) {
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
