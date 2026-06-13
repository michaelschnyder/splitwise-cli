import { Command } from 'commander';
import { Chalk } from 'chalk';
import { createConsola, type ConsolaReporter } from 'consola';
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
type LogLevelName = 'error' | 'warn' | 'info' | 'debug' | 'trace';

type Logger = {
  error: (message: string) => void;
  warn: (message: string) => void;
  info: (message: string) => void;
  debug: (message: string) => void;
  trace: (message: string) => void;
  start: (message: string) => void;
  success: (message: string) => void;
  fail: (message: string) => void;
  withTag: (tag: string) => Logger;
};

/** Attach -o / --output to any command that produces structured output. */
export function addOutputOption(cmd: Command): Command {
  return cmd.option('-o, --output <format>', 'Output format: table | json | yaml');
}

export function addLoggingOptions(cmd: Command): Command {
  return cmd
    .option('--log <level>', 'Log level: error | warn | info | debug | trace')
    .option(
      '-v, --verbose',
      'Increase verbosity (-v, -vv, -vvv, -vvvv)',
      (_value: string | undefined, previous: number) => previous + 1,
      0,
    );
}

export function getFormat(cmd: Command): OutputFormat {
  const fmt = (cmd.optsWithGlobals().output as string) ?? 'table';
  if (!['table', 'json', 'yaml'].includes(fmt)) {
    process.stderr.write(`Unknown format "${fmt}". Use: table, json, yaml\n`);
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
type LogTypeIcon = 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'success' | 'start' | 'fail' | 'log';

const chalkStdout = new Chalk({ level: process.stdout.isTTY && process.env.NO_COLOR === undefined ? 1 : 0 });
const chalkStderr = new Chalk({ level: process.stderr.isTTY && process.env.NO_COLOR === undefined ? 1 : 0 });

const UNICODE_ICONS: Record<LogTypeIcon, string> = {
  error: '✖',
  warn: '⚠',
  info: 'ℹ',
  debug: '⚙',
  trace: '→',
  success: '✔',
  start: '◐',
  fail: '✖',
  log: '•',
};

const ASCII_ICONS: Record<LogTypeIcon, string> = {
  error: 'x',
  warn: '!',
  info: 'i',
  debug: 'D',
  trace: '>',
  success: '+',
  start: '>',
  fail: 'x',
  log: '*',
};

function truthyEnv(name: string): boolean {
  const raw = process.env[name];
  if (raw === undefined) return false;
  const value = raw.trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes';
}

function parseLogLevelName(value: string | undefined): LogLevelName | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'error' || normalized === 'warn' || normalized === 'info' || normalized === 'debug' || normalized === 'trace') {
    return normalized;
  }
  return undefined;
}

function supportsUnicode(stream: 'stdout' | 'stderr' = 'stdout'): boolean {
  const isTTY = stream === 'stdout' ? process.stdout.isTTY : process.stderr.isTTY;
  if (!isTTY) return false;
  if (process.env.TERM === 'dumb') return false;
  return true;
}

function iconForType(type: string, stream: 'stdout' | 'stderr' = 'stderr'): string {
  const normalized = type.toLowerCase() as LogTypeIcon;
  const key: LogTypeIcon =
    normalized === 'error' || normalized === 'warn' || normalized === 'info' || normalized === 'debug' ||
    normalized === 'trace' || normalized === 'success' || normalized === 'start' || normalized === 'fail'
      ? normalized
      : 'log';
  const icons = supportsUnicode(stream) ? UNICODE_ICONS : ASCII_ICONS;
  return icons[key];
}

function levelFromVerboseCount(count: number): LogLevelName | undefined {
  if (count <= 0) return undefined;
  if (count === 1) return 'info';
  if (count === 2) return 'debug';
  return 'trace';
}

function levelToNumber(level: LogLevelName): number {
  switch (level) {
    case 'error': return 0;
    case 'warn': return 1;
    case 'info': return 3;
    case 'debug': return 4;
    case 'trace': return 5;
  }
}

function shouldColorLogs(cmd?: Command): boolean {
  if (!cmd) return false;
  const format = getFormat(cmd);
  if (format !== 'table') return false;
  return process.stderr.isTTY && process.env.NO_COLOR === undefined;
}

function resolveLogLevel(cmd?: Command): LogLevelName {
  return resolveEffectiveLogLevel({
    swDebug: truthyEnv('SW_DEBUG'),
    log: (cmd?.optsWithGlobals() as { log?: string } | undefined)?.log,
    verbose: (cmd?.optsWithGlobals() as { verbose?: number } | undefined)?.verbose,
    format: cmd ? getFormat(cmd) : 'json',
  });
}

export function resolveEffectiveLogLevel(input: {
  swDebug: boolean;
  log?: string;
  verbose?: number;
  format: OutputFormat;
}): LogLevelName {
  if (input.swDebug) return 'trace';
  const fromLog = parseLogLevelName(input.log);
  if (fromLog) return fromLog;
  const fromVerbose = levelFromVerboseCount(input.verbose ?? 0);
  if (fromVerbose) return fromVerbose;
  if (input.format === 'table') return 'info';
  return 'warn';
}

function formatLogLine(
  type: string,
  tag: string | undefined,
  text: string,
  colored: boolean,
  iconOnlyStatus: boolean,
): string {
  const upperType = type.toUpperCase();
  const icon = iconForType(type, 'stderr');
  const isStatusType = ['info', 'start', 'success', 'fail'].includes(type.toLowerCase());
  const pieces = iconOnlyStatus && isStatusType
    ? [`${icon}`]
    : [`${icon} [${upperType}]`];
  if (tag) pieces.push(`[${tag}]`);
  pieces.push(text);
  const line = pieces.join(' ');
  if (!colored) return line;
  const color: TuiColor =
    type === 'error' || type === 'fail' ? 'red'
      : type === 'warn' ? 'yellow'
        : type === 'success' ? 'green'
          : type === 'debug' || type === 'trace' ? 'dim'
            : 'cyan';
  return colorize(line, color, 'stderr');
}

function createStderrReporter(colored: boolean, iconOnlyStatus: boolean): ConsolaReporter {
  return {
    log(logObj) {
      const args = logObj.args ?? [];
      const body = args
        .map((arg) => (arg instanceof Error ? arg.message : String(arg)))
        .join(' ')
        .trim();
      const line = formatLogLine(logObj.type ?? 'log', logObj.tag, body, colored, iconOnlyStatus);
      process.stderr.write(`${line}\n`);
    },
  };
}

export function createLogger(cmd?: Command, tag?: string): Logger {
  const level = resolveLogLevel(cmd);
  const colored = shouldColorLogs(cmd);
  const iconOnlyStatus = cmd ? getFormat(cmd) === 'table' : false;
  const reporter = createStderrReporter(colored, iconOnlyStatus);
  const base = createConsola({
    level: levelToNumber(level),
    reporters: [reporter],
    stdout: process.stderr,
    stderr: process.stderr,
  });

  const scoped = tag ? base.withTag(tag) : base;
  const wrap = (c: typeof scoped): Logger => ({
    error: (message: string) => c.error(message),
    warn: (message: string) => c.warn(message),
    info: (message: string) => c.info(message),
    debug: (message: string) => c.debug(message),
    trace: (message: string) => c.trace(message),
    start: (message: string) => c.start(message),
    success: (message: string) => c.success(message),
    fail: (message: string) => c.fail(message),
    withTag: (nextTag: string) => wrap(c.withTag(nextTag)),
  });

  return wrap(scoped);
}

function supportsColor(stream: 'stdout' | 'stderr' = 'stdout'): boolean {
  if (process.env.NO_COLOR !== undefined) return false;
  return stream === 'stdout' ? process.stdout.isTTY : process.stderr.isTTY;
}

export function colorize(text: string, color: TuiColor, stream: 'stdout' | 'stderr' = 'stdout'): string {
  if (!supportsColor(stream)) return text;
  const chalk = stream === 'stdout' ? chalkStdout : chalkStderr;
  switch (color) {
    case 'cyan': return chalk.cyan(text);
    case 'green': return chalk.green(text);
    case 'red': return chalk.red(text);
    case 'yellow': return chalk.yellow(text);
    case 'dim': return chalk.dim(text);
  }
}

export type TuiProgress = {
  start: (message: string) => void;
  stop: (finalMessage?: string, status?: 'success' | 'error' | 'neutral') => void;
  fail: (finalMessage?: string) => void;
};

export function writeTuiInfoSpacer(enabled: boolean): void {
  if (!enabled) return;
  process.stderr.write('\n');
}

export function createTuiProgress(enabled: boolean): TuiProgress {
  const canRender = enabled && process.stderr.isTTY;
  let active = false;
  let spinnerTimer: NodeJS.Timeout | undefined;
  let spinnerMessage = '';
  let spinnerFrame = 0;

  const spinnerFrames = supportsUnicode('stderr')
    ? ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
    : ['-', '\\', '|', '/'];

  const renderSpinner = () => {
    if (!canRender || !active) return;
    const frame = spinnerFrames[spinnerFrame % spinnerFrames.length];
    spinnerFrame += 1;
    const line = colorize(`${frame} ${spinnerMessage}`, 'dim', 'stderr');
    try {
      process.stderr.write(`\r\x1b[2K${line}`);
    } catch {
      active = false;
    }
  };

  const clearLine = () => {
    if (!canRender || !active) return;
    process.stderr.write('\r\x1b[2K');
    active = false;
  };

  const progressIcon = (status: 'success' | 'error' | 'neutral'): string => {
    if (status === 'success') return iconForType('success', 'stderr');
    if (status === 'error') return iconForType('error', 'stderr');
    return iconForType('info', 'stderr');
  };

  const progressColor = (status: 'success' | 'error' | 'neutral'): TuiColor => {
    if (status === 'success') return 'green';
    if (status === 'error') return 'red';
    return 'dim';
  };

  return {
    start: (message: string) => {
      if (!canRender) return;
      spinnerMessage = message;
      spinnerFrame = 0;
      active = true;
      renderSpinner();
      if (!spinnerTimer) {
        spinnerTimer = setInterval(renderSpinner, 90);
        // Avoid keeping the process alive on a timer-only handle.
        if (typeof spinnerTimer.unref === 'function') spinnerTimer.unref();
      }
    },
    stop: (finalMessage?: string, status: 'success' | 'error' | 'neutral' = 'success') => {
      if (spinnerTimer) {
        clearInterval(spinnerTimer);
        spinnerTimer = undefined;
      }
      if (!canRender) {
        if (finalMessage) process.stderr.write(`${progressIcon(status)} ${finalMessage}\n`);
        return;
      }
      clearLine();
      if (finalMessage) {
        const line = `${progressIcon(status)} ${finalMessage}`;
        process.stderr.write(`${colorize(line, progressColor(status), 'stderr')}\n`);
      }
    },
    fail: (finalMessage?: string) => {
      if (spinnerTimer) {
        clearInterval(spinnerTimer);
        spinnerTimer = undefined;
      }
      if (!canRender) {
        if (finalMessage) process.stderr.write(`${progressIcon('error')} ${finalMessage}\n`);
        return;
      }
      clearLine();
      if (finalMessage) {
        const line = `${progressIcon('error')} ${finalMessage}`;
        process.stderr.write(`${colorize(line, 'red', 'stderr')}\n`);
      }
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
export function renderOne(
  record: Record<string, unknown>,
  format: OutputFormat,
  options?: { tuiMode?: boolean },
): void {
  if (format === 'table') {
    if (options?.tuiMode) process.stdout.write('\n');
    for (const [k, v] of Object.entries(record)) {
      const key = supportsColor('stdout') ? chalkStdout.bold(k.padEnd(16)) : k.padEnd(16);
      console.log(`${key} ${String(v)}`);
    }
    if (options?.tuiMode) process.stdout.write('\n');
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
  logger?: Logger;
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

  if (options.logger) {
    process.stderr.write('\n');
    options.logger.info(options.intro);
  } else {
    console.log('');
    console.log(colorize(options.intro, 'cyan', 'stdout'));
  }

  if (rows.length === 0) {
    const elapsed = Date.now() - startedAt;
    if (options.logger) {
      options.logger.info('(no results)');
      options.logger.info(`• 0 item(s) | ${elapsed} ms | source: ${options.source}`);
    } else {
      console.log('\n(no results)');
      console.log(colorize(`\n• 0 item(s) | ${elapsed} ms | source: ${options.source}`, 'dim', 'stdout'));
    }
    return;
  }

  const keys = Object.keys(rows[0]);
  const labels = keys.map(headerLabel);
  const widths = keys.map((k, i) =>
    Math.max(labels[i].length, ...rows.map((r) => visualWidth(String(r[k] ?? '')))),
  );

  console.log('');
  const styledLabels = labels.map((label) =>
    supportsColor('stdout') ? chalkStdout.bold.cyan(label) : label,
  );
  process.stdout.write(
    styledLabels.map((label, i) => padEndVisual(label, widths[i])).join(tableGap) + '\n',
  );
  const separator = widths.map((w) => '─'.repeat(w)).join(tableGap);
  process.stdout.write(`${supportsColor('stdout') ? chalkStdout.dim(separator) : separator}\n`);

  for (const row of rows) {
    process.stdout.write(
      keys.map((k, i) => padEndVisual(String(row[k] ?? ''), widths[i])).join(tableGap) + '\n',
    );
  }

  process.stdout.write('\n');

  const elapsed = Date.now() - startedAt;
  if (options.logger) {
    options.logger.info(`• ${rows.length} item(s) | ${elapsed} ms | source: ${options.source}`);
    process.stderr.write('\n');
  } else {
    console.log(colorize(`\n• ${rows.length} item(s) | ${elapsed} ms | source: ${options.source}`, 'dim', 'stdout'));
  }
}

// ── Unicode-aware display-width helpers ───────────────────────────────────────

/**
 * Returns the terminal display width of a string, counting wide characters
 * (emoji, CJK, etc.) as 2 and zero-width characters as 0.
 */
export function visualWidth(str: string): number {
  const stripped = str.replace(/\x1b\[[0-9;]*m/g, '');
  const hasGraphemeSegmenter = typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function';
  const segments = hasGraphemeSegmenter
    ? [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(stripped)].map((s) => s.segment)
    : Array.from(stripped);

  const envEmojiWidth = process.env.SW_EMOJI_WIDTH?.trim();
  const configuredEmojiWidth = envEmojiWidth === '1' || envEmojiWidth === '2'
    ? Number(envEmojiWidth)
    : undefined;
  const mingwLikeShell = (process.env.MSYSTEM ?? '').toUpperCase().startsWith('MINGW');
  const emojiWidth = configuredEmojiWidth ?? (mingwLikeShell ? 1 : 2);

  let width = 0;
  for (const segment of segments) {
    // Emoji width differs by terminal; allow env override and tune for Git Bash.
    if (/\p{Extended_Pictographic}/u.test(segment)) {
      width += emojiWidth;
      continue;
    }

    for (const char of segment) {
      const cp = char.codePointAt(0) ?? 0;
    if (
      cp === 0 ||
      (cp >= 0x200B && cp <= 0x200F) || // zero-width space / joiners
      cp === 0x20E3 ||                   // combining enclosing keycap
      cp === 0xFE0F ||                   // variation selector-16 (emoji style)
      cp === 0xFEFF ||                   // BOM
      (cp >= 0x0300 && cp <= 0x036F)     // combining diacritics
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
