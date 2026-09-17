import type { NewThreadRequest } from "@get-bb/plugin-sdk";
import { z } from "zod";

// The host validates the complete native request again at threads.spawn.
// Keep JSON mentions intact, including plugin mentions and attachment metadata.
const jsonRecord = z.record(z.string(), z.json());
const mention = z.object({
  start: z.number(),
  end: z.number(),
  resource: jsonRecord,
});
const input = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("text"),
    text: z.string(),
    mentions: z.array(mention),
    visibility: z.literal("agent-only").optional(),
  }),
  z.object({
    type: z.literal("image"),
    url: z.string(),
    visibility: z.literal("agent-only").optional(),
  }),
  z.object({
    type: z.literal("localImage"),
    path: z.string(),
    visibility: z.literal("agent-only").optional(),
  }),
  z.object({
    type: z.literal("localFile"),
    path: z.string(),
    name: z.string().optional(),
    mimeType: z.string().optional(),
    sizeBytes: z.number().optional(),
    visibility: z.literal("agent-only").optional(),
  }),
]);
const environment = z.discriminatedUnion("type", [
  z.object({ type: z.literal("reuse"), environmentId: z.string().min(1) }),
  z.object({ type: z.literal("project-default") }),
  z.object({
    type: z.literal("host"),
    hostId: z.string().optional(),
    workspace: jsonRecord,
  }),
  z.object({
    type: z.literal("provider"),
    environmentProviderId: z.string().min(1),
    inputs: z.json(),
    machine: jsonRecord.optional(),
  }),
]);
const source = z.string().min(1);
export const sessionRequestSchema = z
  .object({
    projectId: z.string().min(1),
    providerId: z.string().min(1),
    model: z.string().min(1),
    // BB owns valid execution choices, including values added after this SDK version.
    reasoningLevel: z.string().min(1),
    permissionMode: z.string().min(1),
    serviceTier: z.string().min(1).optional(),
    executionInputSources: z.record(z.string(), source),
    environment,
    input: z.array(input).min(1),
    sendAt: z.number().finite().optional(),
  })
  .transform((value) => value as NewThreadRequest);

export const sessionResultSchema = z.object({
  threadId: z.string().regex(/^thr_[a-z0-9]+$/),
  taskId: z.string().nullable(),
  attachmentError: z.string().nullable(),
});
export type SessionResult = z.infer<typeof sessionResultSchema>;
