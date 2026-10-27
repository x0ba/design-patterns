import { randomBytes } from "node:crypto";
import { mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export class Output {
  static write(path: string, body: string | Uint8Array): void {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = join(
      dirname(path),
      `.${basename(path)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`,
    );
    try {
      writeFileSync(tmp, body);
      renameSync(tmp, path);
    } catch (error) {
      try {
        unlinkSync(tmp);
      } catch {
        // The temp file may not exist if the write itself failed.
      }
      throw error;
    }
  }
}
