import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";

export async function checkoutRoot(cwd: string): Promise<string> {
  const root = await new Promise<string | null>((resolve, reject) => {
    execFile(
      "git",
      ["-C", cwd, "rev-parse", "--show-toplevel"],
      { encoding: "utf8", timeout: 5000, maxBuffer: 64 * 1024 },
      (error, stdout, stderr) => {
        if (!error) {
          resolve(stdout.trim());
          return;
        }
        if (error.code === 128 && stderr.includes("not a git repository")) {
          resolve(null);
          return;
        }
        reject(error);
      },
    );
  });
  return realpath(root ?? cwd);
}
