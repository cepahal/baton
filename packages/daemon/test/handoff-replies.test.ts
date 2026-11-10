import { HandoffCodeMessage, HandoffWrittenMessage } from "@baton/core";
import { describe, expect, it } from "vitest";
import { codeMessage, writtenReply } from "../src/handoff-replies.js";

const requestId = "r0123456789abcdef";

describe("a daemon's answers to the team server", () => {
  it("reports a write that throws as a failed write, not silence", async () => {
    const reply = await writtenReply(
      { type: "handoff_write", requestId, id: "habcdefghij", folder: "/work/speech" },
      async () => {
        throw new Error("EACCES: permission denied, mkdir '/work/speech/.baton'\n    at mkdir");
      },
    );
    expect(HandoffWrittenMessage.parse(reply)).toEqual(reply);
    expect(reply).toMatchObject({ type: "handoff_written", requestId, id: "habcdefghij" });
    expect(reply.result).toEqual({
      ok: false,
      error: "Couldn't save the handoff: EACCES: permission denied, mkdir '/work/speech/.baton'",
    });
  });

  it("passes a write's own result through", async () => {
    const result = { ok: false as const, error: "Pick a folder", needFolder: true };
    const reply = await writtenReply(
      { type: "handoff_write", requestId, id: "habcdefghij" },
      async (_id, folder) => {
        expect(folder).toBeUndefined();
        return result;
      },
    );
    expect(reply.result).toEqual(result);
  });

  it("reports changes that can't be collected as unavailable, with the reason", async () => {
    const reply = await codeMessage(
      { type: "handoff_code_request", requestId, sessionId: "s1" },
      async () => {
        throw new Error("x".repeat(2000));
      },
    );
    // Long errors are cut to fit the protocol, so the server accepts the reply.
    expect(HandoffCodeMessage.parse(reply)).toEqual(reply);
    expect(reply.code.state).toBe("unavailable");
    expect(reply.code.reason).toMatch(/^Couldn't collect the changes: x+$/);
    expect(reply).not.toHaveProperty("patch");
  });

  it("sends a collected patch as base64", async () => {
    const reply = await codeMessage(
      { type: "handoff_code_request", requestId, sessionId: "s1" },
      async (sessionId) => {
        expect(sessionId).toBe("s1");
        return { code: { state: "attached", bytes: 3 }, patch: Buffer.from("abc") };
      },
    );
    expect(reply.code).toEqual({ state: "attached", bytes: 3 });
    expect(reply.patch).toBe(Buffer.from("abc").toString("base64"));
  });
});
