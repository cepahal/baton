import { memo } from "react";
import ReactMarkdown, { type Components, defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";

const plugins = [remarkGfm];

/** Images may only come from this hub's own note files: no tracking pixels, no `data:`. */
const SAME_ORIGIN_BLOB = /^\/blobs\/[0-9a-f]{64}(?:\?[^#]*)?$/;

/**
 * Every URL in rendered markdown passes through here. Links keep
 * react-markdown's safe protocols (http, https, mailto and relative; never
 * `javascript:`, `vbscript:` or `data:`). Images are dropped unless they are
 * one of this hub's note files.
 */
export function safeUrl(url: string, key: string): string | null {
  const safe = defaultUrlTransform(url);
  if (key === "src") return SAME_ORIGIN_BLOB.test(safe) ? safe : null;
  return safe === "" ? null : safe;
}

const components: Components = {
  a: ({ href, children }) =>
    href ? (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer nofollow"
        // Inside a sticky note or card, following a link mustn't also open the note.
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </a>
    ) : (
      <span>{children}</span>
    ),
  img: ({ src, alt }) =>
    typeof src === "string" && src !== "" ? (
      <img src={src} alt={alt ?? ""} loading="lazy" />
    ) : (
      <span className="md-img-blocked" title="Images from other sites aren't shown">
        [image{alt ? `: ${alt}` : ""}]
      </span>
    ),
};

/**
 * Markdown from agents' replies and teammates' sticky notes. Raw HTML in the
 * text is shown as text, never rendered: react-markdown escapes it without
 * rehype-raw (never add rehype-raw here). Don't add `skipHtml`, which deletes
 * it instead (`Promise<void>` would show as `Promise`). See markdown.test.tsx
 * for the payloads this must survive.
 */
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={plugins} urlTransform={safeUrl} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
});
