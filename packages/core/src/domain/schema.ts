import { z } from "zod";

/** What kind of work a session is doing. */
export const DOMAIN_LABELS = ["frontend", "backend", "ml", "data", "infra", "unknown"] as const;
export const DomainLabel = z.enum(DOMAIN_LABELS);
export type DomainLabel = z.infer<typeof DomainLabel>;

/** Output of `classifyDomain`. */
export const DomainClassification = z.object({
  label: DomainLabel,
  /** 0–1: the top label's share of the evidence, scaled down when there is little of it. */
  confidence: z.number().min(0).max(1),
  /** Human-readable evidence, strongest first. */
  reasons: z.array(z.string()),
});
export type DomainClassification = z.infer<typeof DomainClassification>;
