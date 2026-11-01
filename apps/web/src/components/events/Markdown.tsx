import { memo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

const plugins = [remarkGfm];

/**
 * Reply markdown. Raw HTML in the text is shown as text, never rendered:
 * react-markdown escapes it without rehype-raw. Don't add `skipHtml`, which
 * deletes it instead (`Promise<void>` would show as `Promise`).
 */
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={plugins}>{text}</ReactMarkdown>
    </div>
  );
});
