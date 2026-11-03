import { describe, expect, it } from "vitest";
import {
  type BatonEvent,
  classifyDomain,
  DOMAIN_RULES,
  DOMAIN_WINDOW,
  DomainClassification,
  parseSession,
  parseTranscript,
  touchedPaths,
} from "../src/index.js";
import { CWD, jsonl, toolResult, toolUse, user } from "./helpers.js";

/** Small Claude Code transcripts, one per domain, parsed by the real parser. */
let id = 0;
const edit = (path: string) => [
  toolUse(`t${++id}`, "Edit", { file_path: `${CWD}/${path}`, old_string: "a", new_string: "b" }),
  toolResult(`t${id}`, "ok"),
];
const write = (path: string) => [
  toolUse(`t${++id}`, "Write", { file_path: `${CWD}/${path}`, content: "x" }),
  toolResult(`t${id}`, "ok"),
];
const multi = (path: string) => [
  toolUse(`t${++id}`, "MultiEdit", { file_path: `${CWD}/${path}`, edits: [] }),
  toolResult(`t${id}`, "ok"),
];
const claude = (...lines: (string | string[])[]) => parseTranscript(jsonl(...lines.flat())).events;

const FIXTURES: Record<Exclude<DomainClassification["label"], "unknown">, BatonEvent[]> = {
  frontend: claude(
    user("The sidebar layout breaks on mobile, make it responsive"),
    edit("apps/web/src/components/Sidebar.tsx"),
    edit("apps/web/src/styles/app.css"),
    write("apps/web/src/components/Nav.tsx"),
  ),
  backend: claude(
    user("Add a REST endpoint for invoices with auth middleware"),
    edit("services/billing/routes/invoices.go"),
    write("services/billing/handlers/auth.go"),
    multi("services/billing/main.go"),
  ),
  ml: claude(
    user("Fine-tune the classifier, the training loss plateaus after epoch 3"),
    edit("models/train.py"),
    edit("models/config.yaml"),
    write("checkpoints/notes.md"),
    edit("src/training/loss.py"),
  ),
  data: claude(
    user("The ETL pipeline drops rows; fix the dbt model and the SQL query"),
    edit("warehouse/models/orders.sql"),
    write("warehouse/seeds/regions.csv"),
    edit("pipelines/etl/load.py"),
  ),
  infra: claude(
    user("Deploy to staging: fix the terraform module and the CI workflow"),
    edit("infra/main.tf"),
    edit(".github/workflows/ci.yml"),
    write("Dockerfile"),
    edit("k8s/deployment.yaml"),
  ),
};

describe("classifyDomain", () => {
  it.each(Object.entries(FIXTURES))("labels a %s session", (label, events) => {
    const result = classifyDomain(events);
    expect(DomainClassification.parse(result)).toEqual(result);
    expect(result.label).toBe(label);
    expect(result.confidence).toBeGreaterThanOrEqual(0.5);
    expect(result.reasons[0]).toMatch(/^edited /);
  });

  it("says unknown, with no confidence, when nothing points anywhere", () => {
    const events = claude(user("hello"), toolUse("r1", "Read", { file_path: `${CWD}/README` }));
    expect(classifyDomain(events)).toEqual({
      label: "unknown",
      confidence: 0,
      reasons: ["no domain signals"],
    });
    expect(classifyDomain([])).toMatchObject({ label: "unknown", confidence: 0 });
  });

  it("explains its answer with readable, repo-relative reasons", () => {
    const result = classifyDomain(FIXTURES.frontend);
    expect(result.reasons).toContain("edited apps/web/src/components/Sidebar.tsx (web/)");
    expect(result.reasons.some((r) => r.startsWith('prompt says "'))).toBe(true);
  });

  it("ranks file edits above prompt words", () => {
    const events = claude(
      user("react component css tailwind layout"), // five frontend words, capped at three
      edit("server/api/handler.go"),
    );
    expect(classifyDomain(events).label).toBe("backend");
  });

  it("uses the repo-relative cwd when there are no edits", () => {
    const events = claude(user("why is this slow?"));
    const result = classifyDomain(events, { repoRelativeCwd: "infra/terraform" });
    expect(result).toMatchObject({ label: "infra" });
    expect(result.reasons[0]).toBe("cwd infra/terraform (infra/)");
    // The repo root itself says nothing.
    expect(classifyDomain(events, { repoRelativeCwd: "" }).label).toBe("unknown");
  });

  it("is less confident with thin evidence than with plenty", () => {
    const thin = classifyDomain(claude(user("fix the css")));
    const thick = classifyDomain(FIXTURES.frontend);
    expect(thin.label).toBe("frontend");
    expect(thin.confidence).toBeLessThan(0.5);
    expect(thick.confidence).toBeGreaterThan(thin.confidence);
  });

  it("reports a tie as unknown", () => {
    const events = claude(edit("web/a.tsx"), edit("infra/main.tf"));
    const result = classifyDomain(events);
    expect(result.label).toBe("unknown");
    expect(result.reasons[0]).toBe("tie between frontend, infra");
  });

  it("follows a session that moves from one domain to another", () => {
    const backendWork = claude(
      user("add the invoices endpoint"),
      ...Array.from({ length: 8 }, (_, i) => edit(`server/routes/r${i}.go`)),
    );
    const frontendWork = claude(
      user("now build the invoices page"),
      ...Array.from({ length: 15 }, (_, i) => edit(`web/src/components/C${i}.tsx`)),
    );
    expect(classifyDomain(backendWork).label).toBe("backend");
    const mid = classifyDomain([...backendWork, ...frontendWork.slice(0, 6)]);
    expect(mid.label).toBe("backend");
    const shifted = classifyDomain([...backendWork, ...frontendWork]);
    expect(frontendWork.length).toBeGreaterThanOrEqual(DOMAIN_WINDOW / 2);
    expect(shifted.label).toBe("frontend");
    // Once the backend edits leave the window, nothing of them remains.
    const later = classifyDomain([...backendWork, ...frontendWork, ...frontendWork]);
    expect(later.label).toBe("frontend");
    expect(later.reasons.join(" ")).not.toContain("backend");
  });

  it("reads Codex file changes", () => {
    const events = parseSession(
      "codex",
      [
        JSON.stringify({
          timestamp: "2026-11-01T12:00:00.000Z",
          ordinal: 0,
          type: "session_meta",
          payload: {
            id: "00000000-0000-4000-8000-000000000002",
            cwd: "C:\\proj",
            cli_version: "0.1.0",
          },
        }),
        JSON.stringify({
          timestamp: "2026-11-01T12:00:01.000Z",
          ordinal: 1,
          type: "event_msg",
          payload: {
            type: "item_completed",
            thread_id: "00000000-0000-4000-8000-000000000002",
            turn_id: "t1",
            item: {
              type: "FileChange",
              id: "p1",
              changes: {
                "C:\\proj\\terraform\\main.tf": { type: "update" },
                "C:\\proj\\helm\\values.yaml": { type: "add" },
              },
              status: "completed",
              stdout: "",
              stderr: "",
            },
          },
        }),
      ].join("\n"),
    ).events;
    const call = events.find((e) => e.kind === "tool_call");
    expect(call && touchedPaths(call)).toEqual([
      "C:\\proj\\terraform\\main.tf",
      "C:\\proj\\helm\\values.yaml",
    ]);
    const result = classifyDomain(events);
    expect(result.label).toBe("infra");
    expect(result.reasons).toContain("edited terraform/main.tf (terraform/)");
  });

  it("never throws on odd tool inputs", () => {
    const odd = claude(
      toolUse("o1", "Edit", { file_path: 42 }),
      toolUse("o2", "Write", {}),
      toolUse("o3", "NotebookEdit", { notebook_path: `${CWD}/sql/eda.ipynb` }),
    );
    expect(classifyDomain(odd).label).toBe("data");
    // A notebook alone is as much ml as data.
    const notebook = claude(toolUse("o4", "NotebookEdit", { notebook_path: `${CWD}/eda.ipynb` }));
    expect(classifyDomain(notebook).reasons[0]).toBe("tie between ml, data");
  });
});

describe("DOMAIN_RULES", () => {
  it("has one row per label, lower-case entries, and no duplicates within a row", () => {
    expect(new Set(DOMAIN_RULES.map((r) => r.label)).size).toBe(DOMAIN_RULES.length);
    for (const rule of DOMAIN_RULES) {
      for (const list of [rule.extensions, rule.dirs, rule.keywords]) {
        expect(list.every((s) => s === s.toLowerCase())).toBe(true);
        expect(new Set(list).size).toBe(list.length);
      }
    }
  });
});
