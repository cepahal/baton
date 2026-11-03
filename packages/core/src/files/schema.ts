import { z } from "zod";

/** A file a session wrote. `ranges` are inclusive 1-based lines; empty when unknown. */
export const TouchedFile = z.object({
  path: z.string().min(1),
  ranges: z.array(z.tuple([z.number().int().positive(), z.number().int().positive()])),
});
export type TouchedFile = z.infer<typeof TouchedFile>;
