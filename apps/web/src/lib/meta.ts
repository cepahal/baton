import type { BatonEvent } from "@baton/core";

// Typed reads of `event.meta`. Missing or mistyped keys read as undefined;
// the spec says viewers ignore keys they don't understand.

export function metaString(event: BatonEvent, key: string): string | undefined {
  const v = event.meta?.[key];
  return typeof v === "string" ? v : undefined;
}

export function metaNumber(event: BatonEvent, key: string): number | undefined {
  const v = event.meta?.[key];
  return typeof v === "number" ? v : undefined;
}

export function metaBool(event: BatonEvent, key: string): boolean {
  return event.meta?.[key] === true;
}
