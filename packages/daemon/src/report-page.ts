import type {
  FastifyInstance,
  RawReplyDefaultExpression,
  RawRequestDefaultExpression,
  RawServerDefault,
} from "fastify";
import type { Logger } from "pino";
import { PAGE_CSP } from "./inbox-page.js";
import { buildReport, ISSUES_URL } from "./report.js";

type BatonApp = FastifyInstance<
  RawServerDefault,
  RawRequestDefaultExpression,
  RawReplyDefaultExpression,
  Logger
>;

const esc = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
  );

export function reportPage(report: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Report a Baton issue</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
body{margin:0;padding:32px 24px;font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;color:#26324a;background:#fff8f0}
main{max-width:900px;margin:0 auto}h1{font-size:22px;margin:0 0 8px}
p{color:#5d6a82}textarea{width:100%;height:55vh;font:12px/1.45 ui-monospace,Consolas,monospace;padding:12px;border:1px solid #e5d6c6;border-radius:10px;background:#fffdf9}
.row{display:flex;gap:10px;margin:12px 0}button,a.btn{font:inherit;padding:8px 14px;border-radius:999px;border:1px solid #d9620a;background:#ff8a2b;color:#fff;text-decoration:none;cursor:pointer}
a.btn.alt{background:#fff;color:#d9620a}
</style></head><body><main>
<h1>Report an issue</h1>
<p>This is your Baton's version and its last log lines, from <strong>this machine only</strong>.
Tokens, things that look like keys, and your home folder are already removed, but read it before you
share it. Then copy it into a new issue and say what you were doing.</p>
<div class="row"><button type="button" id="copy">Copy report</button>
<a class="btn alt" href="${esc(ISSUES_URL)}" target="_blank" rel="noopener noreferrer">Open a new issue</a></div>
<textarea id="report" readonly spellcheck="false">${esc(report)}</textarea>
<script>
document.getElementById("copy").addEventListener("click", async (e) => {
  const t = document.getElementById("report");
  try { await navigator.clipboard.writeText(t.value); } catch { t.select(); document.execCommand("copy"); }
  e.target.textContent = "Copied";
});
</script>
</main></body></html>`;
}

/**
 * `GET /report` on a daemon's own localhost server: the "Report issue" page.
 * Never on a team server; the logs stay on the machine that wrote them.
 */
export function registerReportRoute(
  app: BatonApp,
  input: { logFile: string; secrets: readonly string[]; facts?: Record<string, string> },
): void {
  app.get("/report", async (_req, reply) =>
    reply
      .type("text/html")
      .header("content-security-policy", PAGE_CSP)
      .header("x-frame-options", "DENY")
      .header("cache-control", "no-store")
      .send(reportPage(await buildReport(input))),
  );
}
