import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { BATON_VERSION } from "@baton/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseCli } from "../src/cli.js";
import { runLocal } from "../src/local-commands.js";
import { readSharing } from "../src/sharing.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "baton-local-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const collect = () => {
  let text = "";
  const write = (t: string) => {
    text += t;
  };
  return { out: { write }, text: () => text };
};

describe("parsing the local commands", () => {
  it("shares the folder `pnpm baton` was typed in, not the repo root", () => {
    const r = parseCli(["share"], { INIT_CWD: "/work/app" });
    expect(r).toMatchObject({
      command: "local",
      action: { kind: "share", dir: resolve("/work/app") },
    });
    const sub = parseCli(["share", "sub"], { INIT_CWD: "/work/app" });
    expect(sub).toMatchObject({ action: { dir: resolve("/work/app/sub") } });
  });

  it("puts the sharing file next to the state file", () => {
    const r = parseCli(["pause", "--state-file", join(dir, "state.json")], {});
    expect(r).toEqual({
      command: "local",
      action: { kind: "pause", sharingFile: join(dir, "sharing.json") },
    });
  });

  it("knows --version, doctor's flags, and refuses flags a command doesn't take", () => {
    expect(parseCli(["--version"], {})).toEqual({ command: "local", action: { kind: "version" } });
    const doctor = parseCli(["doctor", "--server", "ws://team:7777"], { BATON_TOKEN: "t" });
    expect(doctor).toMatchObject({
      action: { kind: "doctor", input: { server: "ws://team:7777", token: "t" } },
    });
    expect(parseCli(["share", "--server", "ws://x"], {})).toEqual({
      command: "error",
      message: "--server isn't a share option",
    });
    expect(parseCli(["sharing", "extra"], {})).toMatchObject({ command: "error" });
  });
});

describe("running them", () => {
  it("shares a folder, pauses, resumes, lists and unshares", async () => {
    const sharingFile = join(dir, "sharing.json");
    const folder = join(dir, "notes");
    await mkdir(folder);

    const a = collect();
    expect(await runLocal({ kind: "share", dir: folder, sharingFile }, a.out)).toBe(0);
    expect(a.text()).toContain(`Sharing sessions in ${folder}`);
    expect(await readSharing(sharingFile)).toMatchObject({ paused: false, folders: [folder] });

    // Sharing the same folder twice keeps one entry.
    await runLocal({ kind: "share", dir: folder, sharingFile }, collect().out);
    expect((await readSharing(sharingFile))?.folders).toEqual([folder]);

    await runLocal({ kind: "pause", sharingFile }, collect().out);
    const listed = collect();
    await runLocal({ kind: "sharing", sharingFile }, listed.out);
    expect(listed.text()).toContain("PAUSED");
    expect(listed.text()).toContain(`folder  ${folder}`);
    await runLocal({ kind: "resume", sharingFile }, collect().out);
    expect((await readSharing(sharingFile))?.paused).toBe(false);

    const gone = collect();
    await runLocal({ kind: "unshare", dir: folder, sharingFile }, gone.out);
    expect(gone.text()).toContain("Stopped sharing");
    expect((await readSharing(sharingFile))?.folders).toEqual([]);
  });

  it("refuses to share a folder that doesn't exist", async () => {
    const r = collect();
    const code = await runLocal(
      { kind: "share", dir: join(dir, "nope"), sharingFile: join(dir, "sharing.json") },
      r.out,
    );
    expect(code).toBe(2);
    expect(r.text()).toContain("is not a folder");
  });

  it("prints the version", async () => {
    const r = collect();
    await runLocal({ kind: "version" }, r.out);
    expect(r.text()).toBe(`baton ${BATON_VERSION}\n`);
  });
});
