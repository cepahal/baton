import { DOMAIN_LABELS, type DomainLabel } from "@baton/core";
import { useState } from "react";
import type { CanvasCard } from "../../lib/canvas-model.js";

type Props = {
  domain: CanvasCard["domain"];
  /** A label picked by hand, or `null` to go back to automatic. */
  onPick(label: DomainLabel | null): void;
};

const PICKABLE = DOMAIN_LABELS.filter((l) => l !== "unknown");

/** The session's domain and confidence. Blank when undetermined. Click to set it by hand. */
export function DomainChip({ domain, onPick }: Props) {
  const [open, setOpen] = useState(false);
  const pick = (label: DomainLabel | null) => {
    setOpen(false);
    onPick(label);
  };
  return (
    <span className="domain nodrag">
      <button
        type="button"
        className={`domain-chip${domain ? ` is-${domain.label}` : " is-blank"}`}
        aria-haspopup="menu"
        aria-expanded={open}
        title={
          domain
            ? domain.manual
              ? "Set by hand. Click to change"
              : "Click to change"
            : "Set domain"
        }
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
      >
        {domain && (
          <>
            {domain.label}
            <span className="domain-conf">
              {domain.manual ? "manual" : `${Math.round(domain.confidence * 100)}%`}
            </span>
          </>
        )}
      </button>
      {open && (
        <span className="domain-menu" role="menu">
          {PICKABLE.map((label) => (
            <button
              key={label}
              type="button"
              role="menuitemradio"
              aria-checked={domain?.label === label}
              className={`domain-option is-${label}`}
              onClick={(e) => {
                e.stopPropagation();
                pick(label);
              }}
            >
              {label}
            </button>
          ))}
          <button
            type="button"
            role="menuitem"
            className="domain-option is-auto"
            onClick={(e) => {
              e.stopPropagation();
              pick(null);
            }}
          >
            automatic
          </button>
        </span>
      )}
    </span>
  );
}
