import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const MACHINE_ID = /^[0-9a-f]{32}$/;

export const newMachineId = (): string => randomBytes(16).toString("hex");

/**
 * This machine's id for the team server: random, made once and kept in the
 * state dir. It lets the server tell a daemon reconnecting from one machine
 * using a name taken by another. Not a secret and not proof of identity.
 */
export async function loadMachineId(file: string): Promise<string> {
  try {
    const id = (await readFile(file, "utf8")).trim();
    if (MACHINE_ID.test(id)) return id;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  const id = newMachineId();
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${id}\n`);
  return id;
}
