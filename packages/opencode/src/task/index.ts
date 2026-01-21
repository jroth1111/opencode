import z from "zod"

export namespace Task {
  export const Status = z.enum(["draft", "open", "in_progress", "blocked", "deferred", "closed"])
  export type Status = z.infer<typeof Status>

  export const Lane = z.enum(["session", "repo"])
  export type Lane = z.infer<typeof Lane>

  export const Priority = z.number().int().min(0).max(4)
  export type Priority = z.infer<typeof Priority>

  export const Tracker = z
    .object({
      id: z.string().describe("Tracker plugin or backend id"),
      mode: z.enum(["session", "repo"]).optional().describe("Tracker scope"),
      path: z.string().optional().describe("Tracker storage path (if applicable)"),
      config: z.record(z.string(), z.any()).optional().describe("Tracker configuration metadata"),
    })
    .describe("Task tracker metadata")
  export type Tracker = z.infer<typeof Tracker>

  export const Info = z
    .object({
      content: z.string().describe("Brief description of the task"),
      status: Status.describe("Current status of the task: open, in_progress, blocked, deferred, closed"),
      priority: Priority.describe("Priority level of the task: 0 (P0) - 4 (P4)"),
      id: z.string().describe("Unique identifier for the task"),
      version: z.number().int().nonnegative().optional().describe("Monotonic version for optimistic updates"),
      lane: Lane.optional().describe("Task lane: session (default) or repo"),
      checkpoint: z
        .boolean()
        .optional()
        .describe("Requires explicit approval before marking as closed"),
      issueType: z.string().optional().describe("Custom issue type"),
      tracker: Tracker.optional(),
      files: z.array(z.string()).optional().describe("Relevant files to touch or verify"),
      labels: z.array(z.string()).optional().describe("Custom labels for grouping or filtering"),
      action: z.string().optional().describe("Implementation steps or approach"),
      verify: z.string().optional().describe("How to verify the task is complete"),
      done: z.string().optional().describe("Acceptance criteria for completion"),
      dependsOn: z.array(z.string()).optional().describe("Task IDs this task depends on"),
      blocks: z.array(z.string()).optional().describe("Task IDs blocked by this task"),
      parentId: z.string().optional().describe("Parent task ID for hierarchical grouping"),
      assignee: z.string().optional().describe("Assigned agent or user"),
      estimateMinutes: z.number().int().positive().optional().describe("Estimated minutes to complete"),
    })
    .meta({ ref: "Task" })
  export type Info = z.infer<typeof Info>

  export type Summary = Pick<Info, "id" | "content" | "status" | "version" | "parentId"> & {
    lane?: Lane
  }

  export type GraphEdge = {
    from: string
    to: string
    type: "parent" | "dependsOn" | "blocks" | "child"
  }

  export type Graph = {
    root: Summary
    nodes: Summary[]
    edges?: GraphEdge[]
  }

  export function normalizeStatus(status?: string): Status {
    if (!status) return "open"
    const value = status.trim().toLowerCase()
    switch (value) {
      case "draft":
        return "draft"
      case "open":
      case "in_progress":
      case "blocked":
      case "deferred":
      case "closed":
        return value
      case "pending":
        return "open"
      case "completed":
        return "closed"
      case "planned":
        return "draft"
      case "canceled":
      case "cancelled":
        return "deferred"
      default:
        return "open"
    }
  }

  export function normalizePriority(priority?: number | string | null): Priority {
    if (priority === undefined || priority === null) return 2
    if (typeof priority === "number") {
      if (Number.isNaN(priority)) return 2
      return Math.min(4, Math.max(0, Math.round(priority)))
    }
    const value = priority.trim().toLowerCase()
    if (/^p?\d$/.test(value)) {
      const numeric = Number(value.replace("p", ""))
      if (!Number.isNaN(numeric)) {
        return Math.min(4, Math.max(0, Math.round(numeric)))
      }
    }
    switch (value) {
      case "critical":
      case "urgent":
      case "highest":
        return 0
      case "high":
        return 1
      case "medium":
        return 2
      case "low":
        return 3
      case "lowest":
        return 4
      default:
        return 2
    }
  }

  export function normalizeLane(lane?: string | null): Lane {
    if (!lane) return "session"
    const value = lane.trim().toLowerCase()
    if (value === "repo") return "repo"
    return "session"
  }

  export function fromTodo(input: {
    id: string
    content: string
    status?: string | null
    priority?: number | string | null
  }): Info {
    return {
      id: input.id,
      content: input.content,
      status: normalizeStatus(input.status ?? undefined),
      priority: normalizePriority(input.priority),
    }
  }

  export function isBlockingStatus(status: string) {
    return ["open", "in_progress", "blocked"].includes(normalizeStatus(status))
  }

  export function isDoneStatus(status: string) {
    return ["closed", "deferred"].includes(normalizeStatus(status))
  }

  export function pickFocused(todos: Info[]): Info | undefined {
    if (!todos || todos.length === 0) return
    const blocking = todos.filter((todo) => isBlockingStatus(todo.status))
    if (blocking.length === 0) return
    const inProgress = blocking.find((todo) => normalizeStatus(todo.status) === "in_progress")
    return inProgress ?? blocking[0]
  }

  export function normalize(task: Info): Info {
    const normalizeList = (items?: string[]) => {
      if (!items || items.length === 0) return undefined
      const normalized = Array.from(
        new Set(
          items
            .map((item) => item?.toString().trim())
            .filter((item): item is string => !!item),
        ),
      )
      return normalized.length ? normalized : undefined
    }
    const normalizeText = (value?: string | null) => {
      if (!value) return undefined
      const trimmed = value.trim()
      return trimmed.length ? trimmed : undefined
    }
    const normalizeTracker = (tracker?: Tracker | null) => {
      if (!tracker) return undefined
      const id = tracker.id?.toString().trim()
      if (!id) return undefined
      const mode: Lane | undefined =
        tracker.mode === "repo" ? "repo" : tracker.mode === "session" ? "session" : undefined
      const path = tracker.path?.toString().trim()
      return {
        id,
        mode,
        path: path?.length ? path : undefined,
        config: tracker.config,
      }
    }
    return {
      content: task.content,
      id: task.id || task.content,
      version: task.version,
      status: normalizeStatus(task.status),
      priority: normalizePriority(task.priority),
      lane: normalizeLane(task.lane),
      checkpoint: !!task.checkpoint,
      issueType: normalizeText(task.issueType),
      tracker: normalizeTracker(task.tracker),
      files: normalizeList(task.files),
      labels: normalizeList(task.labels),
      action: normalizeText(task.action),
      verify: normalizeText(task.verify),
      done: normalizeText(task.done),
      dependsOn: normalizeList(task.dependsOn),
      blocks: normalizeList(task.blocks),
      parentId: normalizeText(task.parentId),
      assignee: normalizeText(task.assignee),
      estimateMinutes: task.estimateMinutes,
    }
  }

  export function formatPriority(priority: Priority) {
    return `P${normalizePriority(priority)}`
  }

  export function toPlanPriority(priority: Priority): "high" | "medium" | "low" {
    const normalized = normalizePriority(priority)
    if (normalized <= 1) return "high"
    if (normalized === 2) return "medium"
    return "low"
  }

  export const SpecFields = ["verify", "done"] as const
  export type SpecField = (typeof SpecFields)[number]

  export function missingSpec(task: Info): SpecField[] {
    const missing: SpecField[] = []
    if (!task.verify) missing.push("verify")
    if (!task.done) missing.push("done")
    return missing
  }

  export function isSpecComplete(task: Info) {
    return missingSpec(task).length === 0
  }
}
