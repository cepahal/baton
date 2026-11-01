import { memo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

const plugins = [remarkGfm];

/** Reply markdown. Raw HTML in the text is shown as text, never rendered. */
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={plugins} skipHtml>
        {text}
      </ReactMarkdown>
    </div>
  );
});
