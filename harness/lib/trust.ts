/** Match the option title independently of terminal wrapping; Enter still requires a verified selection. */
export function sessionOnlyTrustIndex(capture: string): number {
  if (!capture.includes("Trust (this session only)"))
    throw new Error("No session-only trust option");
  return /Trust parent folder/.test(capture) ? 2 : 1;
}
