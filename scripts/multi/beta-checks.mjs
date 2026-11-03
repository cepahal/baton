// Checks pnpm test:multi runs beyond exactly-once delivery, against the live
// stack: what isn't shared never arrives, the server kept the state files an
// older Baton wrote, old daemons are told to update, a second machine can't
// take a connected daemon's name, and sessions in one repo are grouped.
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { join } from "node:path";
import { BATON_VERSION, INGEST_PROTOCOL_VERSION } from "../../packages/core/dist/index.js";
import { BASE_URL, PRIVATE_MACHINE, SHARED_REPO, TOKEN } from "./fleet.mjs";
import { api, compose, sessions } from "./lib.mjs";

// `ws` is the daemon's dependency; Node's own WebSocket can't send an Authorization header.
const WebSocket = createRequire(join(import.meta.dirname, "../../packages/daemon/package.json"))(
  "ws",
);

/** Opens `/ingest` with a hand-made query; resolves with the first message the server sends. */
function firstIngestMessage(query) {
  const url = new URL("/ingest", BASE_URL.replace("http", "ws"));
  url.search = new URLSearchParams(query).toString();
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers: { authorization: `Bearer ${TOKEN}` } });
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error("no message within 5 s"));
    }, 5000);
    ws.once("message", (data) => {
      clearTimeout(timer);
      ws.close();
      resolve(JSON.parse(String(data)));
    });
    ws.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

const current = (name) => ({
  name,
  protocol: String(INGEST_PROTOCOL_VERSION),
  app: BATON_VERSION,
  machine: randomBytes(16).toString("hex"),
});

/** Returns problems as strings; none means every check passed. */
export async function betaChecks() {
  const problems = [];
  const list = await sessions();

  // Privacy: the machine that shares nothing sent nothing, and it really ran.
  const leaked = list.filter((s) => s.source === PRIVATE_MACHINE);
  if (leaked.length > 0)
    problems.push(`${PRIVATE_MACHINE}: ${leaked.length} unshared session(s) reached the server`);
  const privateLogs = await compose(["logs", PRIVATE_MACHINE], { quiet: true, allowFail: true });
  if (!privateLogs.includes("not sharing sessions in this folder")) {
    problems.push(
      `${PRIVATE_MACHINE}: its daemon never saw its session, so the privacy check proved nothing`,
    );
  }

  // Grouping: alice and bob work in the same repo.
  for (const name of ["alice", "bob"]) {
    const s = list.find((x) => x.source === name);
    if (s?.repo?.repoId !== SHARED_REPO) {
      problems.push(`${name}: repo ${s?.repo?.repoId ?? "none"}, expected ${SHARED_REPO}`);
    }
  }

  // Upgrade: the legacy files the server started on are all still there.
  const { notes } = await api("/notes");
  if (!notes.some((n) => n.id === "n0legacy001" && n.text.includes("Kept across the upgrade"))) {
    problems.push("upgrade: the note from the 0.0.0 notes file is missing");
  }
  const { handoffs } = await api("/handoffs");
  if (!handoffs.some((h) => h.id === "h0legacy001" && h.status === "declined")) {
    problems.push("upgrade: the handoff from the 0.0.0 handoffs file is missing");
  }
  const { positions } = await api("/canvas");
  if (positions["repo:legacy"]?.x !== -400) {
    problems.push("upgrade: the canvas position from the 0.0.0 canvas file is missing");
  }

  // Handshake: a daemon from before versioning is told to update...
  const old = await firstIngestMessage({ name: "old-daemon" }).catch((e) => ({ error: e }));
  if (old.type !== "error" || old.code !== "version" || !/update Baton/.test(old.message)) {
    problems.push(
      `handshake: an old daemon got ${JSON.stringify(old)}, expected a "please update" error`,
    );
  }
  // ...a current one is greeted with the server's version...
  const hello = await firstIngestMessage(current("doctor-probe")).catch((e) => ({ error: e }));
  if (hello.type !== "ingest_hello" || hello.app !== BATON_VERSION) {
    problems.push(
      `handshake: a current daemon got ${JSON.stringify(hello)}, expected ingest_hello`,
    );
  }
  // ...and another machine can't take a connected daemon's name.
  const impostor = await firstIngestMessage(current("alice")).catch((e) => ({ error: e }));
  if (impostor.type !== "error" || impostor.code !== "name_taken") {
    problems.push(`names: a second "alice" got ${JSON.stringify(impostor)}, expected name_taken`);
  }
  return problems;
}
