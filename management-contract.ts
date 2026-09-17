import { z } from "zod";

export const managedProjectSchema = z.object({
  id: z.string(),
  name: z.string(),
  prefix: z.string(),
  color: z.string().default("slategray"),
  folderId: z.string().nullable().default(null),
  linkedBbProjectId: z.string().nullable().default(null),
});
export type ManagedProject = z.infer<typeof managedProjectSchema>;
export const projectFields = managedProjectSchema.omit({
  id: true,
  prefix: true,
});
const name = z.string().trim().min(1).max(180);
export const projectPrefix = z
  .string()
  .regex(
    /^[A-Z][A-Z0-9]{0,9}$/,
    "Use 1–10 uppercase letters or digits, starting with a letter.",
  );
export const managementInput = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("createProject"),
      requestId: z.string().uuid(),
      name,
      prefix: projectPrefix,
      color: z.string().min(1).max(40),
      folderId: z.string().nullable(),
      linkedBbProjectId: z.string().nullable(),
    })
    .strict(),
  z
    .object({
      action: z.literal("editProject"),
      projectId: z.string().min(1),
      name,
      color: z.string().min(1).max(40),
      folderId: z.string().nullable(),
      linkedBbProjectId: z.string().nullable(),
      expected: projectFields,
    })
    .strict(),
  z
    .object({
      action: z.literal("createTask"),
      requestId: z.string().uuid(),
      projectId: z.string().min(1),
      title: name,
      description: z.string().max(30000).default(""),
    })
    .strict(),
  z
    .object({
      action: z.literal("attachSession"),
      projectId: z.string().min(1),
      taskId: z.string().min(1),
      threadId: z.string().regex(/^thr_[a-z0-9]+$/),
    })
    .strict(),
]);
export type ManagementInput = z.infer<typeof managementInput>;
export const managementResult = z.object({
  project: managedProjectSchema.optional(),
  task: z
    .object({ id: z.string(), key: z.string(), projectId: z.string() })
    .optional(),
  threadId: z.string().optional(),
});
export type ManagementResult = z.infer<typeof managementResult>;
export const managementOptions = z.object({
  projects: z.array(managedProjectSchema),
  folders: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      parentFolderId: z.string().nullable().optional(),
    }),
  ),
  bbProjects: z.array(z.object({ id: z.string(), name: z.string() })),
});
export type ManagementOptions = z.infer<typeof managementOptions>;
export const managementContract = {
  managementOptions: { input: z.null(), output: managementOptions },
  manage: { input: managementInput, output: managementResult },
};
