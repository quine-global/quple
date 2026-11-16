// The app's recent log, for debugging on a phone with no Xcode attached:
// everything written to the console (the Jitsi SDK logs there too) and any
// uncaught JavaScript error, kept in memory (the last MAX lines) and copied
// out from Settings → Copy debug log. Imported first (index.js), so it
// catches everything after it.

const MAX = 800;
const lines: string[] = [];

function stringify(x: unknown): string {
  if (typeof x === 'string') return x;
  if (x instanceof Error) return `${x.name}: ${x.message}${x.stack ? `\n${x.stack}` : ''}`;
  try {
    return JSON.stringify(x);
  } catch {
    return String(x);
  }
}

export function record(level: string, args: unknown[]) {
  const t = new Date().toISOString().slice(11, 23);
  lines.push(`${t} ${level} ${args.map(stringify).join(' ')}`.slice(0, 2000));
  if (lines.length > MAX) lines.splice(0, lines.length - MAX);
}

for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
  const original = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    record(level, args);
    original(...args);
  };
}

const ErrorUtils = (globalThis as any).ErrorUtils;
if (ErrorUtils?.getGlobalHandler) {
  const previous = ErrorUtils.getGlobalHandler();
  ErrorUtils.setGlobalHandler((error: unknown, isFatal?: boolean) => {
    record(isFatal ? 'FATAL' : 'uncaught', [error]);
    previous?.(error, isFatal);
  });
}

/** The log so far, oldest first. */
export function dump(): string {
  return lines.join('\n');
}
