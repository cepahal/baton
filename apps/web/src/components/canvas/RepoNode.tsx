import type { Node, NodeProps } from "@xyflow/react";

export type RepoNodeData = { title: string; subtitle: string; count: number };
export type RepoNodeType = Node<RepoNodeData, "repo">;

/** A repo group: its cards sit inside. Drag the header to move the whole group. */
export function RepoNode({ data }: NodeProps<RepoNodeType>) {
  return (
    <section className="repo-group" aria-label={`Repo ${data.title}`}>
      <header className="repo-head">
        <span className="repo-title">{data.title}</span>
        <span className="repo-sub" title={data.subtitle}>
          {data.subtitle}
        </span>
        <span className="repo-count">{data.count}</span>
      </header>
    </section>
  );
}
