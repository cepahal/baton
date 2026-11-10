import type {
  HandoffCodeMessage,
  HandoffCodeRequestMessage,
  HandoffWriteMessage,
  HandoffWriteResult,
  HandoffWrittenMessage,
} from "@baton/core";
import type { CodeReply } from "./handoff-route.js";

/** An error as one short line for the other side, within the protocol's limits. */
const describe = (err: unknown, max: number): string => {
  const text = err instanceof Error ? err.message : String(err);
  return (text.split("\n")[0] ?? "").slice(0, max) || "unknown error";
};

/**
 * The answer to `handoff_write`. Always resolves: a failed write is reported
 * as such, so the receiver's browser shows why instead of waiting out the
 * server's timeout and blaming the connection.
 */
export async function writtenReply(
  message: HandoffWriteMessage,
  write: (id: string, folder?: string) => Promise<HandoffWriteResult>,
): Promise<HandoffWrittenMessage> {
  let result: HandoffWriteResult;
  try {
    result = await write(message.id, message.folder);
  } catch (err) {
    result = { ok: false, error: `Couldn't save the handoff: ${describe(err, 900)}` };
  }
  return { type: "handoff_written", requestId: message.requestId, id: message.id, result };
}

/**
 * The answer to `handoff_code_request`. Always resolves: if collecting the
 * changes fails, the code is reported unavailable with the reason.
 */
export async function codeMessage(
  message: HandoffCodeRequestMessage,
  code: (sessionId: string) => Promise<CodeReply>,
): Promise<HandoffCodeMessage> {
  let reply: CodeReply;
  try {
    reply = await code(message.sessionId);
  } catch (err) {
    reply = {
      code: { state: "unavailable", reason: `Couldn't collect the changes: ${describe(err, 450)}` },
    };
  }
  return {
    type: "handoff_code",
    requestId: message.requestId,
    code: reply.code,
    ...(reply.patch ? { patch: reply.patch.toString("base64") } : {}),
  };
}
