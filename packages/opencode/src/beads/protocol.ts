import z from "zod"

export const BeadsIssueSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string().optional(),
  status: z.string().optional(),
  priority: z.number().int().optional(),
  issue_type: z.string().optional(),
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

export const BeadsIssueInputSchema = z.object({
  title: z.string(),
  description: z.string().optional(),
  issue_type: z.string().optional(),
  priority: z.number().int().optional(),
  labels: z.array(z.string()).optional(),
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
  issue_type: z.string().optional(),
  add_labels: z.array(z.string()).optional(),
  remove_labels: z.array(z.string()).optional(),
  set_labels: z.array(z.string()).optional(),
  external_ref: z.string().optional(),
})
export type BeadsUpdateArgs = z.infer<typeof BeadsUpdateArgsSchema>

export const BeadsCloseArgsSchema = z.object({
  id: z.string(),
  reason: z.string().optional(),
  session: z.string().optional(),
})
export type BeadsCloseArgs = z.infer<typeof BeadsCloseArgsSchema>

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
