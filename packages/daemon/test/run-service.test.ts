import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createLogger } from "../src/logging.js";
import { runService } from "../src/run-service.js";

describe("a refused daemon", () => {
  it("closes before exiting, even when refused while still starting", async () => {
    const steps: string[] = [];
    await runService({
      start: async (onRefused) => {
        onRefused("name taken"); // e.g. during sink.start(), before close exists
        return async () => {
          steps.push("close");
        };
      },
      report: (m) => steps.push(`report ${m}`),
      exit: (code) => steps.push(`exit ${code}`),
    });
    await expect.poll(() => steps).toEqual(["report name taken", "close", "exit 1"]);
  });

  it("closes and exits when refused after starting, once", async () => {
    const steps: string[] = [];
    let refuse: (m: string) => void = () => {};
    await runService({
      start: async (onRefused) => {
        refuse = onRefused;
        return async () => {
          steps.push("close");
        };
      },
      report: (m) => steps.push(`report ${m}`),
      exit: (code) => steps.push(`exit ${code}`),
    });
    expect(steps).toEqual([]);
    refuse("version");
    refuse("version");
    await expect.poll(() => steps).toEqual(["report version", "close", "exit 1"]);
  });

  it("has its last log line in the file by the time it exits", async () => {
    const dir = await mkdtemp(join(tmpdir(), "baton-log-"));
    try {
      const file = join(dir, "logs", "daemon.log");
      const logger = createLogger("info", file);
      logger.error("the team server refused this daemon");
      // Read straight away, as if process.exit came next.
      expect(await readFile(file, "utf8")).toContain("the team server refused this daemon");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
