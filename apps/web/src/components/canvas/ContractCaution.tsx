import type { ContractIssue } from "@baton/core";

/**
 * A caution sign with a one-line guess at an I/O mismatch with another
 * session in the repo. The rest, if any, are in the tooltip.
 */
export function ContractCaution({ issues }: { issues: readonly ContractIssue[] | undefined }) {
  const first = issues?.[0];
  if (!issues || !first) return null;
  const more = issues.length - 1;
  return (
    <div
      className="scard-caution"
      role="note"
      title={issues.map((i) => `⚠ ${i.message}`).join("\n")}
    >
      <span className="scard-caution-icon" role="img" aria-label="Possible I/O mismatch">
        ⚠
      </span>
      <span className="scard-caution-text">{first.message}</span>
      {more > 0 ? <span className="scard-caution-more">+{more}</span> : null}
    </div>
  );
}
