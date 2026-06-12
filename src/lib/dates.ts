/**
 * Parse a date string that is either an ISO date (YYYY-MM-DD) or a relative
 * expression like -10d, -2w, -1month, -3months, -1y.
 * Returns an ISO date string (YYYY-MM-DD).
 */
export function parseDate(input: string): string {
  const rel = input.match(/^([+-]?\d+)\s*(d|day|days|w|week|weeks|m|month|months|y|year|years)$/i);
  if (rel) {
    const n = parseInt(rel[1], 10);
    const unit = rel[2].toLowerCase();
    const date = new Date();
    if (unit.startsWith('d')) date.setDate(date.getDate() + n);
    else if (unit.startsWith('w')) date.setDate(date.getDate() + n * 7);
    else if (unit.startsWith('m')) date.setMonth(date.getMonth() + n);
    else if (unit.startsWith('y')) date.setFullYear(date.getFullYear() + n);
    return date.toISOString().slice(0, 10);
  }
  // Validate ISO date loosely
  if (!/^\d{4}-\d{2}-\d{2}/.test(input)) {
    console.error(`Invalid date "${input}". Use YYYY-MM-DD or a relative value like -10d, -2w, -1month.`);
    process.exit(1);
  }
  return input;
}
