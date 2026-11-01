import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ConnectionBadge } from "../src/components/ConnectionBadge.js";
import { Markdown } from "../src/components/events/Markdown.js";
import type { ConnectionState } from "../src/lib/connection.js";

describe("Markdown", () => {
  it("shows HTML-like text as text instead of dropping or rendering it", () => {
    const html = renderToStaticMarkup(
      createElement(Markdown, { text: "returns Promise<void>, wrap it in a <div>" }),
    );
    expect(html).toContain("Promise&lt;void&gt;");
    expect(html).toContain("&lt;div&gt;");
    expect(html).not.toContain("<div>");
  });
});

describe("ConnectionBadge", () => {
  const render = (state: ConnectionState) =>
    renderToStaticMarkup(createElement(ConnectionBadge, { state, now: 0, onRetry: () => {} }));

  it("offers Retry only while waiting out backoff", () => {
    const waiting = render({ status: "reconnecting", attempt: 1, gaps: 0, retryAt: 2000 });
    const opening = render({ status: "reconnecting", attempt: 1, gaps: 0 });
    expect(waiting).toContain("Retry");
    expect(opening).not.toContain("Retry");
  });
});
