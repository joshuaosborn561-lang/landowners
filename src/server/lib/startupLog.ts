/** Startup logs: presence booleans only. Never key fragments. */
export function formatStartupKeyFlags(flags: Record<string, boolean>): string {
  return `Keys: ${Object.entries(flags)
    .map(([name, on]) => `${name}=${on}`)
    .join(' ')}`;
}
