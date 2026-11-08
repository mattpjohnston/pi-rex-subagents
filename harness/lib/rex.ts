import { execFile } from "node:child_process";

export interface RexResult {
  code: number;
  stdout: string;
  stderr: string;
  data: unknown;
}

type Log = (argv: string[], result: RexResult) => Promise<void>;

export function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected a Rex JSON object");
  }
  return value as Record<string, unknown>;
}

export function success(result: RexResult): RexResult {
  if (result.code !== 0) {
    throw new Error(`Rex exited ${result.code}: ${result.stderr || result.stdout}`);
  }
  return result;
}

export class Rex {
  private readonly log: Log | undefined;

  constructor(log?: Log) {
    this.log = log;
  }

  async command(argv: string[], json = true): Promise<RexResult> {
    const result = await new Promise<RexResult>((resolve, reject) => {
      execFile(
        process.env.PI_SUBAGENTS_REX ?? "rex",
        argv,
        { encoding: "utf8", timeout: 30_000, maxBuffer: 16 * 1024 * 1024 },
        (error, stdout, stderr) => {
          const code = error?.code ?? 0;
          if (typeof code !== "number" || error?.killed) {
            reject(error);
            return;
          }
          resolve({ code, stdout, stderr, data: null });
        },
      );
    });
    // Preserve the raw reply even if a successful command returns malformed JSON.
    await this.log?.(argv, result);
    if (json && result.code === 0) result.data = JSON.parse(result.stdout) as unknown;
    return result;
  }

  newSession(label: string, cwd: string, argv: string[]): Promise<RexResult> {
    return this.command([
      "new",
      label,
      "-c",
      cwd,
      "--window",
      label,
      "--keep-open",
      "--shell",
      "none",
      "--json",
      "--",
      ...argv,
    ]);
  }

  killSession(id: string): Promise<RexResult> {
    return this.command(["kill", id], false);
  }

  listSessions(): Promise<RexResult> {
    return this.command(["ls", "--json"]);
  }

  inspectSession(id: string): Promise<RexResult> {
    return this.command(["session", "inspect", id, "--json"]);
  }

  capture(sessionId: string, blockId: string): Promise<RexResult> {
    // capture and kill have no JSON option in the installed Rex CLI.
    return this.command(["capture", "-s", sessionId, "-b", blockId, "--trim", "--unwrap"], false);
  }

  wait(sessionId: string, blockId: string): Promise<RexResult> {
    return this.command(["wait", blockId, "-s", sessionId, "--for", "20s", "--json"]);
  }
}
