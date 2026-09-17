import { z } from "zod";

const id = z.string().regex(/^\d{13}-[0-9a-f-]{36}$/);
const day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(
    (s) =>
      Number.isFinite(Date.parse(s)) &&
      new Date(s).toISOString().slice(0, 10) === s,
    "Choose a valid date",
  );
export const settleInput = z
  .object({
    id,
    action: z.enum(["pause", "review", "done", "archive"]),
    taskId: z.string().min(1).optional(),
    threadId: z
      .string()
      .regex(/^thr_[a-z0-9]+$/)
      .optional(),
    expectedUpdatedAt: z.string().optional(),
    nextAction: z.string().max(700).default(""),
    reviewBy: z.enum(["me", "other"]).default("me"),
    reviewer: z.string().max(150).default(""),
    checkAfter: day.optional(),
  })
  .superRefine((input, ctx) => {
    if (
      input.action === "archive"
        ? !input.threadId || !!input.taskId
        : !input.taskId
    )
      ctx.addIssue({
        code: "custom",
        message: "Choose a task or session for this action.",
      });
    if (
      input.action === "review" &&
      input.reviewBy === "other" &&
      (!input.reviewer.trim() || !input.checkAfter)
    )
      ctx.addIssue({
        code: "custom",
        message: "Name the reviewer and choose a follow-up date.",
      });
  });
export type SettleInput = z.infer<typeof settleInput>;
export const settlementSchema = z.object({
  id,
  at: z.number(),
  title: z.string(),
  action: z.enum(["pause", "review", "done", "archive"]),
  taskId: z.string().nullable(),
  taskKey: z.string().nullable(),
  threadId: z.string().nullable(),
  nextAction: z.string(),
  reviewer: z.string(),
  checkAfter: z.string().nullable(),
  taskUpdated: z.boolean(),
  archivedThreadIds: z.array(z.string()),
  undone: z.boolean(),
  warning: z.string().nullable(),
});
export type Settlement = z.infer<typeof settlementSchema>;
export const settlementContract = {
  settle: { input: settleInput, output: settlementSchema },
  undoSettlement: { input: z.object({ id }), output: settlementSchema },
  settledToday: { input: z.null(), output: z.array(settlementSchema) },
};
