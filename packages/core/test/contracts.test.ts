import { describe, expect, it } from "vitest";
import { contractIssues, describeDiff, pathsMatch } from "../src/contracts/compare.js";
import { extractContracts, normalizeEndpointPath, writtenTexts } from "../src/contracts/extract.js";
import type { FileContracts } from "../src/contracts/schema.js";
import type { BatonEvent } from "../src/event.js";

const call = (toolName: string, input: Record<string, unknown>): BatonEvent =>
  ({
    id: "e1",
    agent: "claude-code",
    sessionId: "s",
    projectPath: "/repo",
    ts: "2026-11-03T00:00:00.000Z",
    seq: 1,
    kind: "tool_call",
    text: toolName,
    meta: { toolName, input },
  }) as BatonEvent;

describe("normalizeEndpointPath", () => {
  it.each([
    ["/api/cart/", "/api/cart"],
    ["http://localhost:3000/api/cart?x=1", "/api/cart"],
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a template URL read as source text
    ["${API}/api/items/${id}", "/api/items/:param"],
    ["/api/items/:id", "/api/items/:param"],
    ["/api/items/{item_id}", "/api/items/:param"],
    ["/api/items/[id]", "/api/items/:param"],
    ["/users/<int:id>", "/users/:param"],
    ["/", "/"],
  ])("%s → %s", (raw, want) => {
    expect(normalizeEndpointPath(raw)).toBe(want);
  });

  it("rejects things that aren't paths", () => {
    expect(normalizeEndpointPath("cart")).toBeUndefined();
    expect(normalizeEndpointPath("hello world")).toBeUndefined();
  });

  it("matches params on either side", () => {
    expect(pathsMatch("/api/items/:param", "/api/items/42")).toBe(true);
    expect(pathsMatch("/api/items", "/api/items/42")).toBe(false);
  });
});

describe("extractContracts", () => {
  it("finds Express routes and the fetches that call them", () => {
    const server = extractContracts(
      "api/server.ts",
      `app.get("/api/cart", list);\nrouter.post('/api/cart/:id/items', add);\napp.delete(\`/api/cart/\${id}\`, rm);`,
    );
    expect(server.routes.map((r) => `${r.method} ${r.path}`)).toEqual([
      "GET /api/cart",
      "POST /api/cart/:param/items",
      "DELETE /api/cart/:param",
    ]);
    const client = extractContracts(
      "web/cart.ts",
      `const r = await fetch(\`\${BASE}/api/cart\`);\nawait fetch("/api/cart/7/items", {\n  method: "POST",\n  body,\n});\naxios.put("/api/cart/7");`,
    );
    expect(client.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "GET /api/cart",
      "POST /api/cart/:param/items",
      "PUT /api/cart/:param",
    ]);
  });

  it("finds FastAPI and Flask routes, with Flask methods", () => {
    const py = extractContracts(
      "api/main.py",
      `@app.get("/items/{item_id}")\ndef read(item_id: int): ...\n@bp.route("/login", methods=["POST"])\ndef login(): ...`,
    );
    expect(py.routes.map((r) => `${r.method} ${r.path}`)).toEqual([
      "GET /items/:param",
      "POST /login",
    ]);
  });

  it("finds Next.js app-router and pages-router routes from the file path", () => {
    const app = extractContracts(
      "web/app/api/orders/[id]/route.ts",
      "export async function GET() {}\nexport const DELETE = async () => {}",
    );
    expect(app.routes.map((r) => `${r.method} ${r.path}`)).toEqual([
      "GET /api/orders/:param",
      "DELETE /api/orders/:param",
    ]);
    const pages = extractContracts("pages/api/health.ts", "export default function h() {}");
    expect(pages.routes).toEqual([
      { method: "ANY", path: "/api/health", file: "pages/api/health.ts" },
    ]);
  });

  it("reads TS interfaces and types, zod objects, pydantic models, Go structs", () => {
    const ts = extractContracts(
      "web/types.ts",
      `export interface CartItem extends Base {\n  id: string;\n  price?: number;\n  tags: string[];\n  meta: { a: number; b: string };\n  onClick(): void;\n}\ntype Totals = { sum: number, currency: "EUR" | "USD" };`,
    );
    expect(ts.shapes).toEqual([
      {
        name: "CartItem",
        file: "web/types.ts",
        fields: [
          { name: "id", kind: "string" },
          { name: "price", kind: "number" },
          { name: "tags", kind: "array" },
          { name: "meta", kind: "object" },
        ],
      },
      {
        name: "Totals",
        file: "web/types.ts",
        fields: [
          { name: "sum", kind: "number" },
          { name: "currency", kind: "string" },
        ],
      },
    ]);
    const zod = extractContracts(
      "api/s.ts",
      "const Order = z.object({ id: z.string(), qty: z.number().int(), lines: z.array(Line) });",
    );
    expect(zod.shapes[0]?.fields.map((f) => `${f.name}:${f.kind}`)).toEqual([
      "id:string",
      "qty:number",
      "lines:array",
    ]);
    const py = extractContracts(
      "api/models.py",
      `class CartItem(BaseModel):\n    id: UUID\n    unit_price: float\n    tags: list[str] = []\n    note: Optional[str] = None\n\n    def total(self): ...\n\nclass Helper:\n    x: int\n`,
    );
    expect(py.shapes).toHaveLength(1);
    expect(py.shapes[0]?.fields.map((f) => `${f.name}:${f.kind}`)).toEqual([
      "id:string",
      "unit_price:number",
      "tags:array",
      "note:string",
    ]);
    const go = extractContracts(
      "svc/item.go",
      'type Item struct {\n\tID string `json:"id"`\n\tPrice float64 `json:"price"`\n\tSecret string `json:"-"`\n\tCount int\n}',
    );
    expect(go.shapes[0]?.fields.map((f) => `${f.name}:${f.kind}`)).toEqual([
      "id:string",
      "price:number",
      "Count:number",
    ]);
  });

  it("never throws on junk or unclosed declarations", () => {
    for (const junk of [
      "interface X {",
      "class A(BaseModel):",
      "type T = {",
      "\u0000{{{",
      "fetch(",
      "",
    ]) {
      expect(() => extractContracts("x.ts", junk)).not.toThrow();
    }
  });
});

describe("writtenTexts", () => {
  it("reads Claude Write/Edit/MultiEdit and Codex patches", () => {
    expect(writtenTexts(call("Write", { file_path: "/r/a.ts", content: "x" }))).toEqual([
      { path: "/r/a.ts", text: "x", whole: true },
    ]);
    expect(
      writtenTexts(call("Edit", { file_path: "/r/a.ts", old_string: "o", new_string: "n" })),
    ).toEqual([{ path: "/r/a.ts", text: "n", whole: false }]);
    expect(
      writtenTexts(
        call("MultiEdit", {
          file_path: "/r/a.ts",
          edits: [{ new_string: "a" }, { new_string: "b" }],
        }),
      )[0]?.text,
    ).toBe("a\nb");
    const patch = writtenTexts(
      call("Patch", {
        "/r/n.ts": { type: "add", content: "new" },
        "/r/m.ts": { type: "update", unified_diff: "--- a\n+++ b\n@@ -1 +1 @@\n-old\n+fresh" },
      }),
    );
    expect(patch).toEqual([
      { path: "/r/n.ts", text: "new", whole: true },
      { path: "/r/m.ts", text: "fresh", whole: false },
    ]);
    expect(writtenTexts(call("Read", { file_path: "/r/a.ts" }))).toEqual([]);
  });

  it("extracts Cursor Write and StrReplace content while rejecting malformed content", () => {
    expect(writtenTexts(call("Write", { path: "/r/new.ts", contents: "const x = 1" }))).toEqual([
      { path: "/r/new.ts", text: "const x = 1", whole: true },
    ]);
    expect(writtenTexts(call("StrReplace", { path: "/r/edit.ts", new_string: "updated" }))).toEqual(
      [{ path: "/r/edit.ts", text: "updated", whole: false }],
    );
    expect(writtenTexts(call("Write", { path: "/r/new.ts", contents: 42 }))).toEqual([]);
  });
});

const fields = (n: number, prefix = "f") =>
  Array.from({ length: n }, (_, i) => `  ${prefix}${i}: string;`).join("\n");
const none: FileContracts = { routes: [], calls: [], shapes: [] };

describe("contractIssues", () => {
  it("flags a frontend shape with 47 fields against a backend one with 36", () => {
    const fe = extractContracts("web/types.ts", `export interface Order {\n${fields(47)}\n}`);
    const be = extractContracts("api/models.ts", `export interface Order {\n${fields(36)}\n}`);
    const issues = contractIssues([
      { sessionId: "fe", domain: "frontend", contracts: fe },
      { sessionId: "be", domain: "backend", contracts: be },
    ]);
    const fi = issues.get("fe")?.[0];
    expect(fi?.kind).toBe("shape");
    expect(fi?.message).toContain("47 fields here vs 36 there");
    expect(fi?.message).toContain("backend session");
    expect(fi?.message).toContain("not there: f36, f37, f38 +8");
    expect(fi?.otherSessionId).toBe("be");
    expect(issues.get("be")?.[0]?.message).toContain("missing here: f36");
  });

  it("flags wrong field types and snake/camel naming across languages", () => {
    const fe = extractContracts(
      "web/cart.ts",
      "interface CartItemResponse { id: string; unitPrice: number; qty: number }",
    );
    const be = extractContracts(
      "api/models.py",
      "class CartItem(BaseModel):\n    id: str\n    unit_price: float\n    qty: str\n",
    );
    const issues = contractIssues([
      { sessionId: "fe", domain: "frontend", contracts: fe },
      { sessionId: "be", domain: "backend", contracts: be },
    ]);
    const msg = issues.get("fe")?.[0]?.message ?? "";
    expect(msg).toContain("`qty` is number here, string there");
    expect(msg).toContain("`unitPrice` vs `unit_price`");
  });

  it("stays quiet when shapes agree, or are unrelated, or are UI props", () => {
    const a = extractContracts(
      "web/a.ts",
      "interface User { id: string; name: string }\ninterface ButtonProps { a: string }",
    );
    const b = extractContracts(
      "api/b.ts",
      "interface User { id: string; name: string }\ninterface ButtonProps { z: number }",
    );
    const c = extractContracts(
      "api/c.ts",
      "interface Item { x: string; y: string; z: string; w: string }",
    );
    const d = extractContracts(
      "web/d.ts",
      "interface Item { p: string; q: string; r: string; s: string }",
    );
    expect(
      contractIssues([
        { sessionId: "a", contracts: a },
        { sessionId: "b", contracts: b },
      ]).size,
    ).toBe(0);
    expect(
      contractIssues([
        { sessionId: "c", contracts: c },
        { sessionId: "d", contracts: d },
      ]).size,
    ).toBe(0);
  });

  it("ignores the same file edited by two sessions (that's a file conflict, not I/O)", () => {
    const a = extractContracts("api/t.ts", "interface User { id: string; name: string }");
    const b = extractContracts(
      "api/t.ts",
      "interface User { id: string; email: string; name: string }",
    );
    expect(
      contractIssues([
        { sessionId: "a", contracts: a },
        { sessionId: "b", contracts: b },
      ]).size,
    ).toBe(0);
  });

  it("flags calls to routes the backend doesn't define, or not for that method", () => {
    const be = extractContracts(
      "api/server.ts",
      'app.get("/api/cart", a);\napp.put("/api/cart/:id", b);',
    );
    const fe = extractContracts(
      "web/api.ts",
      'fetch("/api/cart");\nfetch("/api/cart/checkout", { method: "POST" });\naxios.delete("/api/cart/3");\nfetch("/elsewhere/x");',
    );
    const issues = contractIssues([
      { sessionId: "fe", domain: "frontend", contracts: fe },
      { sessionId: "be", domain: "backend", contracts: be },
    ]);
    const msgs = (issues.get("fe") ?? []).map((i) => i.message);
    expect(msgs).toEqual([
      "Calls POST /api/cart/checkout, which the backend session doesn't define (it has other /api/cart routes).",
      "Calls DELETE /api/cart/:param, but the backend session serves that path only as PUT.",
    ]);
    expect((issues.get("be") ?? []).map((i) => i.message)).toEqual([
      "The frontend session calls POST /api/cart/checkout, which isn't defined here.",
      "The frontend session calls DELETE /api/cart/:param; this session serves that path only as PUT.",
    ]);
  });

  it("accepts calls that any session (even the caller's own) serves", () => {
    const full = extractContracts(
      "api/x.ts",
      'app.post("/api/cart/checkout", c);\nfetch("/api/cart/checkout", { method: "POST" });',
    );
    const be = extractContracts("api/server.ts", 'app.get("/api/cart", a);');
    expect(
      contractIssues([
        { sessionId: "full", contracts: full },
        { sessionId: "be", contracts: be },
      ]).size,
    ).toBe(0);
    expect(
      contractIssues([
        { sessionId: "only", contracts: full },
        { sessionId: "empty", contracts: none },
      ]).size,
    ).toBe(0);
  });

  it("caps issues per session and keeps messages short", () => {
    const be = extractContracts("api/s.ts", 'app.get("/api/x", a);');
    const fe = extractContracts(
      "web/c.ts",
      Array.from(
        { length: 12 },
        (_, i) => `fetch("/api/x${i}/y");\nfetch("/api/x/${"y".repeat(150)}${i}");`,
      ).join("\n"),
    );
    const issues = contractIssues([
      { sessionId: "fe", contracts: fe },
      { sessionId: "be", contracts: be },
    ]);
    expect(issues.get("fe")?.length).toBe(5);
    for (const list of issues.values())
      for (const i of list) expect(i.message.length).toBeLessThanOrEqual(240);
  });

  it("describes a diff from both sides consistently", () => {
    const d = describeDiff(
      {
        name: "A",
        file: "a",
        fields: [
          { name: "x", kind: "number" },
          { name: "y", kind: "string" },
        ],
      },
      {
        name: "A",
        file: "b",
        fields: [
          { name: "x", kind: "string" },
          { name: "y", kind: "string" },
        ],
      },
    );
    expect(d).toEqual({
      here: "`x` is number here, string there",
      there: "`x` is string here, number there",
    });
  });
});
