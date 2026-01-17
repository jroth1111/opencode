import z from "zod"

export const BeadsIssueSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string().optional(),
  design: z.string().optional(),
  acceptance_criteria: z.string().optional(),
  notes: z.string().optional(),
  status: z.string().optional(),
  priority: z.number().int().optional(),
  issue_type: z.string().optional(),
  assignee: z.string().optional(),
  parent: z.string().optional(),
  estimated_minutes: z.number().int().optional(),
  dependencies: z
    .array(
      z.object({
        id: z.string(),
        dependency_type: z.string().optional(),
        title: z.string().optional(),
        status: z.string().optional(),
      }),
    )
    .optional(),
  dependents: z
    .array(
      z.object({
        id: z.string(),
        dependency_type: z.string().optional(),
        title: z.string().optional(),
        status: z.string().optional(),
      }),
    )
    .optional(),
  labels: z.array(z.string()).optional(),
  external_ref: z.string().nullable().optional(),
})
export type BeadsIssue = z.infer<typeof BeadsIssueSchema>

export const BeadsIssueWithCountsSchema = z.object({
  issue: BeadsIssueSchema,
  dependency_count: z.number().int().optional(),
  dependent_count: z.number().int().optional(),
})
export type BeadsIssueWithCounts = z.infer<typeof BeadsIssueWithCountsSchema>

export const BeadsListArgsSchema = z.object({
  query: z.string().optional(),
  status: z.string().optional(),
  issue_type: z.string().optional(),
  assignee: z.string().optional(),
  labels: z.array(z.string()).optional(),
  labels_any: z.array(z.string()).optional(),
  ids: z.array(z.string()).optional(),
  limit: z.number().int().optional(),
  include_templates: z.boolean().optional(),
  parent_id: z.string().optional(),
  ephemeral: z.boolean().optional(),
  exclude_status: z.array(z.string()).optional(),
})
export type BeadsListArgs = z.infer<typeof BeadsListArgsSchema>

export const BeadsReadyArgsSchema = z.object({
  assignee: z.string().optional(),
  unassigned: z.boolean().optional(),
  priority: z.number().int().optional(),
  issue_type: z.string().optional(),
  limit: z.number().int().optional(),
  sort: z.string().optional(),
  labels: z.array(z.string()).optional(),
  labels_any: z.array(z.string()).optional(),
  parent_id: z.string().optional(),
  mol_type: z.string().optional(),
  include_deferred: z.boolean().optional(),
})
export type BeadsReadyArgs = z.infer<typeof BeadsReadyArgsSchema>

export const BeadsIssueInputSchema = z.object({
  title: z.string(),
  description: z.string().optional(),
  design: z.string().optional(),
  acceptance_criteria: z.string().optional(),
  notes: z.string().optional(),
  issue_type: z.string().optional(),
  priority: z.number().int().optional(),
  assignee: z.string().optional(),
  labels: z.array(z.string()).optional(),
  dependencies: z.array(z.string()).optional(),
  parent: z.string().optional(),
  estimated_minutes: z.number().int().optional(),
  external_ref: z.string().optional(),
  ephemeral: z.boolean().optional(),
  status: z.string().optional(),
})
export type BeadsIssueInput = z.infer<typeof BeadsIssueInputSchema>

export const BeadsCreateArgsSchema = BeadsIssueInputSchema
export type BeadsCreateArgs = z.infer<typeof BeadsCreateArgsSchema>

export const BeadsUpdateArgsSchema = z.object({
  id: z.string(),
  title: z.string().optional(),
  description: z.string().optional(),
  status: z.string().optional(),
  priority: z.number().int().optional(),
  design: z.string().optional(),
  acceptance_criteria: z.string().optional(),
  notes: z.string().optional(),
  assignee: z.string().optional(),
  estimated_minutes: z.number().int().optional(),
  issue_type: z.string().optional(),
  add_labels: z.array(z.string()).optional(),
  remove_labels: z.array(z.string()).optional(),
  set_labels: z.array(z.string()).optional(),
  external_ref: z.string().optional(),
})
export type BeadsUpdateArgs = z.infer<typeof BeadsUpdateArgsSchema>

export const BeadsDepAddArgsSchema = z.object({
  from_id: z.string(),
  to_id: z.string(),
  dep_type: z.string().optional(),
})
export type BeadsDepAddArgs = z.infer<typeof BeadsDepAddArgsSchema>

export const BeadsDepRemoveArgsSchema = z.object({
  from_id: z.string(),
  to_id: z.string(),
  dep_type: z.string().optional(),
})
export type BeadsDepRemoveArgs = z.infer<typeof BeadsDepRemoveArgsSchema>

export const BeadsCloseArgsSchema = z.object({
  id: z.string(),
  reason: z.string().optional(),
  session: z.string().optional(),
})
export type BeadsCloseArgs = z.infer<typeof BeadsCloseArgsSchema>

export const BeadsCommentSchema = z.object({
  id: z.number().int(),
  issue_id: z.string(),
  author: z.string(),
  text: z.string(),
  created_at: z.string(),
})
export type BeadsComment = z.infer<typeof BeadsCommentSchema>

export const BeadsCommentListArgsSchema = z.object({
  id: z.string(),
})
export type BeadsCommentListArgs = z.infer<typeof BeadsCommentListArgsSchema>

export const BeadsCommentAddArgsSchema = z.object({
  id: z.string(),
  author: z.string(),
  text: z.string(),
})
export type BeadsCommentAddArgs = z.infer<typeof BeadsCommentAddArgsSchema>

export const RpcRequestSchema = z.object({
  operation: z.string(),
  args: z.unknown(),
  cwd: z.string().optional(),
  request_id: z.string().optional(),
  client_version: z.string().optional(),
  expected_db: z.string().optional(),
})
export type RpcRequest = z.infer<typeof RpcRequestSchema>

export const RpcResponseSchema = z.object({
  success: z.boolean(),
  data: z.unknown().optional(),
  error: z.string().optional(),
})
export type RpcResponse = z.infer<typeof RpcResponseSchema>
