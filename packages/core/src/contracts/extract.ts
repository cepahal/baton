import type { BatonEvent, JsonValue } from "../event.js";
import type {
  Endpoint,
  FieldKind,
  FileContracts,
  HttpMethod,
  Shape,
  ShapeField,
} from "./schema.js";

/** Text longer than this is only scanned up to here. */
const MAX_SCAN_CHARS = 200_000;
/** Shapes with more fields than this are cut (and still compared on what's kept). */
const MAX_FIELDS = 200;

/** A file a tool call wrote, with the text it wrote (whole file or fragment). */
export type WrittenText = { path: string; text: string; whole: boolean };

/**
 * Text a tool call wrote: Claude Write content, Edit/MultiEdit replacements,
 * Codex added files and the added lines of Codex diffs.
 */
export function writtenTexts(event: BatonEvent): WrittenText[] {
  if (event.kind !== "tool_call") return [];
  const input = asRecord(event.meta?.input);
  if (!input) return [];
  const path = typeof input.file_path === "string" ? input.file_path : undefined;
  switch (event.meta?.toolName) {
    case "Write":
      return path && typeof input.content === "string"
        ? [{ path, text: input.content, whole: true }]
        : [];
    case "Edit":
      return path && typeof input.new_string === "string"
        ? [{ path, text: input.new_string, whole: false }]
        : [];
    case "MultiEdit": {
      if (!path || !Array.isArray(input.edits)) return [];
      const parts = input.edits.flatMap((e) => {
        const s = asRecord(e)?.new_string;
        return typeof s === "string" ? [s] : [];
      });
      return parts.length > 0 ? [{ path, text: parts.join("\n"), whole: false }] : [];
    }
    case "Patch":
      return Object.entries(input).flatMap(([p, change]): WrittenText[] => {
        const c = asRecord(change);
        if (!c) return [];
        if (c.type === "add" && typeof c.content === "string") {
          return [{ path: p, text: c.content, whole: true }];
        }
        if (typeof c.unified_diff === "string") {
          const added = c.unified_diff
            .split("\n")
            .filter((l) => l.startsWith("+") && !l.startsWith("+++"))
            .map((l) => l.slice(1))
            .join("\n");
          return added ? [{ path: p, text: added, whole: false }] : [];
        }
        return [];
      });
    default:
      return [];
  }
}

/** Routes, calls and shapes in one file's text. Never throws. */
export function extractContracts(file: string, rawText: string): FileContracts {
  const text = rawText.length > MAX_SCAN_CHARS ? rawText.slice(0, MAX_SCAN_CHARS) : rawText;
  return {
    routes: [...declaredRoutes(file, text), ...fileRoutes(file, text)],
    calls: calledEndpoints(file, text),
    shapes: shapes(file, text),
  };
}

// ---------------------------------------------------------------- endpoints

const METHOD = "get|post|put|patch|delete";
const QUOTED = "(['\"`])([^'\"`\\n]*)\\";

/** `app.get("/x")`, `router.post('/x')`, `@app.get("/x")`, `@bp.route("/x")`. */
const ROUTE_CALL = new RegExp(
  `(@?)\\b(?:app|router|api|server|fastify|hono|routes?|bp|blueprint|r)\\.(${METHOD}|route|all)\\(\\s*${QUOTED}3`,
  "gi",
);
const FLASK_METHODS = /methods\s*=\s*\[\s*['"](\w+)['"]/i;
/** Go: `http.HandleFunc("/x"`, `mux.HandleFunc`, `r.HandleFunc`, gin's `r.GET("/x"`. */
const GO_ROUTE = /\b\w+\.(HandleFunc|Handle|GET|POST|PUT|PATCH|DELETE)\(\s*"([^"\n]*)"/g;

function declaredRoutes(file: string, text: string): Endpoint[] {
  const out: Endpoint[] = [];
  for (const m of text.matchAll(ROUTE_CALL)) {
    const verb = (m[2] ?? "").toUpperCase();
    const path = normalizeEndpointPath(m[4] ?? "");
    if (!path) continue;
    let method: HttpMethod = verb === "ROUTE" || verb === "ALL" ? "ANY" : (verb as HttpMethod);
    if (verb === "ROUTE") {
      const tail = text.slice((m.index ?? 0) + m[0].length, (m.index ?? 0) + m[0].length + 120);
      const listed = FLASK_METHODS.exec(tail)?.[1]?.toUpperCase();
      if (listed && isMethod(listed)) method = listed;
    }
    out.push({ method, path, file });
  }
  for (const m of text.matchAll(GO_ROUTE)) {
    const verb = (m[1] ?? "").toUpperCase();
    const path = normalizeEndpointPath(m[2] ?? "");
    if (!path) continue;
    out.push({ method: isMethod(verb) ? verb : "ANY", path, file });
  }
  return out;
}

/** Next.js: `app/api/x/route.ts` exporting `GET`, `pages/api/x.ts`. */
function fileRoutes(file: string, text: string): Endpoint[] {
  const p = file.replace(/\\/g, "/");
  const app = /(?:^|\/)app(\/api\/.*)\/route\.[jt]sx?$/.exec(p);
  if (app?.[1]) {
    const path = normalizeEndpointPath(app[1]);
    const methods = [
      ...text.matchAll(/export\s+(?:async\s+)?(?:function|const)\s+(GET|POST|PUT|PATCH|DELETE)\b/g),
    ].map((m) => m[1] as HttpMethod);
    return path ? methods.map((method) => ({ method, path, file })) : [];
  }
  const pages = /(?:^|\/)pages(\/api\/.*?)(?:\/index)?\.[jt]sx?$/.exec(p);
  if (pages?.[1] && /export\s+default/.test(text)) {
    const path = normalizeEndpointPath(pages[1]);
    return path ? [{ method: "ANY", path, file }] : [];
  }
  return [];
}

const FETCH = new RegExp(`\\b(?:fetch|useSWR|ofetch|\\$fetch|ky)\\(\\s*${QUOTED}1`, "g");
const CLIENT_CALL = new RegExp(
  `\\b(?:axios|api|client|http|request|ky|\\$http)\\.(${METHOD})(?:<[^>\\n]*>)?\\(\\s*${QUOTED}2`,
  "gi",
);
const FETCH_METHOD = /method\s*:\s*['"`](\w+)['"`]/i;
const PY_CALL = new RegExp(
  `\\b(?:requests|httpx|client|session)\\.(${METHOD})\\(\\s*f?${QUOTED}2`,
  "gi",
);

function calledEndpoints(file: string, text: string): Endpoint[] {
  const out: Endpoint[] = [];
  for (const m of text.matchAll(FETCH)) {
    const path = normalizeEndpointPath(m[2] ?? "");
    if (!path) continue;
    const end = (m.index ?? 0) + m[0].length;
    // The options object usually follows within a few lines.
    const tail = text.slice(end, end + 200).split(/\bfetch\(/)[0] ?? "";
    const verb = FETCH_METHOD.exec(tail)?.[1]?.toUpperCase();
    out.push({ method: verb && isMethod(verb) ? verb : "GET", path, file });
  }
  for (const re of [CLIENT_CALL, PY_CALL]) {
    for (const m of text.matchAll(re)) {
      const path = normalizeEndpointPath(m[3] ?? "");
      if (path) out.push({ method: (m[1] ?? "GET").toUpperCase() as HttpMethod, path, file });
    }
  }
  return out;
}

/**
 * An endpoint path in comparable form, or undefined if it isn't one: origins,
 * `${base}` prefixes, queries and trailing slashes dropped; `:id`, `{id}`,
 * `[id]`, `<id>`, `${id}` all become `:param`.
 */
export function normalizeEndpointPath(raw: string): string | undefined {
  let p = raw.trim();
  p = p.replace(/^https?:\/\/[^/]+/i, "");
  p = p.replace(/^(?:\$\{[^}]*\}|\{[^}]*\})+(?=\/)/, "");
  p = p.replace(/[?#].*$/, "");
  if (!p.startsWith("/")) return undefined;
  const segs = p
    .split("/")
    .filter((s) => s !== "")
    .map((s) =>
      /^(?::\w+|\{[^}]*\}|\[[^\]]*\]|<[^>]*>|\$\{[^}]*\})$/.test(s) || /\$\{/.test(s) || isIdLike(s)
        ? ":param"
        : s,
    );
  if (segs.some((s) => /\s/.test(s))) return undefined;
  return `/${segs.join("/")}`;
}

/** Literal ids in called URLs (`/items/42`, a UUID, a long hex hash) stand for a param. */
function isIdLike(seg: string): boolean {
  return (
    /^\d+$/.test(seg) ||
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg) ||
    /^[0-9a-f]{16,}$/i.test(seg)
  );
}

const isMethod = (s: string): s is HttpMethod =>
  ["GET", "POST", "PUT", "PATCH", "DELETE", "ANY"].includes(s);

// ------------------------------------------------------------------- shapes

function shapes(file: string, text: string): Shape[] {
  return [
    ...tsShapes(file, text),
    ...zodShapes(file, text),
    ...pyShapes(file, text),
    ...goShapes(file, text),
  ];
}

/** `interface X {…}` and `type X = {…}`; fields at the top level of the braces only. */
function tsShapes(file: string, text: string): Shape[] {
  const out: Shape[] = [];
  const re =
    /\b(?:interface\s+(\w+)(?:\s*<[^>{]*>)?(?:\s+extends\s+[^{]+)?|type\s+(\w+)(?:\s*<[^>{=]*>)?\s*=)\s*\{/g;
  for (const m of text.matchAll(re)) {
    const name = m[1] ?? m[2];
    const body = braceBody(text, (m.index ?? 0) + m[0].length);
    if (!name || body === undefined) continue;
    const fields: ShapeField[] = [];
    for (const line of topLevel(body).split(/[;\n,]/)) {
      const f = /^\s*(?:readonly\s+)?["']?([A-Za-z_$][\w$]*)["']?\??\s*:\s*(.+?)\s*$/.exec(line);
      if (f?.[1] && f[2]) fields.push({ name: f[1], kind: tsKind(f[2]) });
    }
    push(out, name, fields, file);
  }
  return out;
}

/** `const X = z.object({ a: z.string(), … })`. */
function zodShapes(file: string, text: string): Shape[] {
  const out: Shape[] = [];
  for (const m of text.matchAll(/\b(?:const|let|var)\s+(\w+)\s*=\s*z\.object\(\s*\{/g)) {
    const body = braceBody(text, (m.index ?? 0) + m[0].length);
    if (!m[1] || body === undefined) continue;
    const fields: ShapeField[] = [];
    for (const f of topLevel(body).matchAll(/["']?([A-Za-z_$][\w$]*)["']?\s*:\s*z\.(\w+)/g)) {
      if (f[1]) fields.push({ name: f[1], kind: zodKind(f[2] ?? "") });
    }
    push(out, m[1], fields, file);
  }
  return out;
}

/** Pydantic models, TypedDicts, dataclasses: `class X(BaseModel):` then `name: type` lines. */
function pyShapes(file: string, text: string): Shape[] {
  const out: Shape[] = [];
  const re = /^(@dataclass[^\n]*\n)?class\s+(\w+)\s*(?:\(([^)]*)\))?\s*:[^\n]*\n/gm;
  for (const m of text.matchAll(re)) {
    const bases = m[3] ?? "";
    if (!m[1] && !/BaseModel|TypedDict|Schema|SQLModel/.test(bases)) continue;
    const name = m[2];
    if (!name) continue;
    const fields: ShapeField[] = [];
    const rest = text.slice((m.index ?? 0) + m[0].length).split("\n");
    for (const line of rest) {
      if (line.trim() === "" || /^\s+#/.test(line)) continue;
      if (!/^\s/.test(line)) break;
      if (/^\s+(?:def|class|@|model_config|Config\b)/.test(line)) {
        if (/^\s+(?:def|class)/.test(line)) break;
        continue;
      }
      const f = /^\s+([A-Za-z_]\w*)\s*:\s*([^=#\n]+)/.exec(line);
      if (f?.[1] && f[2]) fields.push({ name: f[1], kind: pyKind(f[2]) });
    }
    push(out, name, fields, file);
  }
  return out;
}

/** `type X struct {…}`; JSON tags name the wire field when present. */
function goShapes(file: string, text: string): Shape[] {
  const out: Shape[] = [];
  for (const m of text.matchAll(/\btype\s+(\w+)\s+struct\s*\{/g)) {
    const body = braceBody(text, (m.index ?? 0) + m[0].length);
    if (!m[1] || body === undefined) continue;
    const fields: ShapeField[] = [];
    for (const line of topLevel(body).split("\n")) {
      const f = /^\s*([A-Z]\w*)\s+([\w.*[\]]+)(?:\s+`[^`]*json:"([^",]*)[^`]*`)?/.exec(line);
      if (!f?.[1] || f[3] === "-") continue;
      fields.push({ name: f[3] || f[1], kind: goKind(f[2] ?? "") });
    }
    push(out, m[1], fields, file);
  }
  return out;
}

function push(out: Shape[], name: string, fields: ShapeField[], file: string) {
  if (fields.length === 0) return;
  const seen = new Set<string>();
  const unique = fields.filter((f) => !seen.has(f.name) && seen.add(f.name));
  out.push({ name, fields: unique.slice(0, MAX_FIELDS), file });
}

/** Text between the `{` just before `start` and its matching `}`; undefined if unclosed. */
function braceBody(text: string, start: number): string | undefined {
  let depth = 1;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return text.slice(start, i);
  }
  return undefined;
}

/** `body` with nested `{…}`, `(…)`, `[…]`, `<…>` contents blanked out. */
function topLevel(body: string): string {
  let depth = 0;
  let out = "";
  for (const c of body) {
    if ("{([<".includes(c)) {
      if (depth === 0) out += c;
      depth++;
    } else if ("})]>".includes(c) && depth > 0) {
      depth--;
      if (depth === 0) out += c;
    } else if (depth === 0) out += c;
  }
  return out;
}

function tsKind(t: string): FieldKind {
  const s = t.replace(/\s*\|\s*(?:null|undefined)\b/g, "").trim();
  if (/\[\]$|^(?:Readonly)?Array\b|^readonly\s/.test(s)) return "array";
  if (/^string\b|^Date\b|^`|^'|^"/.test(s)) return "string";
  if (/^(?:number|bigint)\b/.test(s)) return "number";
  if (/^boolean\b|^true\b|^false\b/.test(s)) return "boolean";
  if (/^\{|^Record\b/.test(s)) return "object";
  return "unknown";
}

function zodKind(t: string): FieldKind {
  if (/^(?:string|email|uuid|url|iso|date|enum|literal)$/.test(t))
    return t === "literal" ? "unknown" : "string";
  if (/^(?:number|int|bigint|float\d*)$/.test(t)) return "number";
  if (t === "boolean") return "boolean";
  if (/^(?:array|tuple)$/.test(t)) return "array";
  if (/^(?:object|record)$/.test(t)) return "object";
  return "unknown";
}

function pyKind(t: string): FieldKind {
  const s = t
    .trim()
    .replace(/^(?:Optional|Annotated)\[(.*)\]$/, "$1")
    .replace(/\s*\|\s*None\b/, "")
    .trim();
  if (/^(?:list|List|Sequence|tuple|Tuple|set|Set)\b/.test(s)) return "array";
  if (/^(?:str|datetime|date|UUID|EmailStr|HttpUrl|Literal\[['"])/.test(s)) return "string";
  if (/^(?:int|float|Decimal|PositiveInt|conint|confloat)\b/.test(s)) return "number";
  if (/^bool\b/.test(s)) return "boolean";
  if (/^(?:dict|Dict|Mapping)\b/.test(s)) return "object";
  return "unknown";
}

function goKind(t: string): FieldKind {
  const s = t.replace(/^\*/, "");
  if (s.startsWith("[]")) return s === "[]byte" ? "string" : "array";
  if (/^(?:string|time\.Time)$/.test(s)) return "string";
  if (/^u?int\d*$|^float\d+$/.test(s)) return "number";
  if (s === "bool") return "boolean";
  if (s.startsWith("map[")) return "object";
  return "unknown";
}

function asRecord(v: JsonValue | undefined): Record<string, JsonValue> | undefined {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? v : undefined;
}
