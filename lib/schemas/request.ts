import { z } from "zod";

export const reviewRequestSchema = z.object({
  repo: z.string().min(1),
  pr_number: z.number().int().positive(),
  diff: z.string(),
  action: z.enum(["opened", "synchronize", "reopened"]),
});

export type ReviewRequest = z.infer<typeof reviewRequestSchema>;
