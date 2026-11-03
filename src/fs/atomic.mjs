/**
 * Same-directory atomic file replacement shared by the local persistence stores.
 *
 * Content goes to a temporary file in the target directory and is then renamed
 * over the target. `rename` is atomic within one filesystem, so a crash can
 * never leave a truncated JSON document that still parses. The temporary file
 * is removed on failure.
 *
 * This is deliberately small: it is not a transaction or a durability layer.
 * The POC accepts the OS page cache (no fsync), as documented in the scheduler
 * design note.
 */
import { randomBytes } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * Atomically replace `filePath` with `data` (string or Buffer).
 *
 * @param {string} filePath
 * @param {string|Buffer} data
 */
export async function atomicWriteFile(filePath, data) {
  const directory = dirname(filePath);
  await mkdir(directory, { recursive: true });
  const tmpPath = join(directory, `.${randomBytes(6).toString("hex")}.tmp`);
  try {
    await writeFile(tmpPath, data, "utf8");
    await rename(tmpPath, filePath);
  } catch (error) {
    await rm(tmpPath, { force: true }).catch(() => {});
    throw error;
  }
}
