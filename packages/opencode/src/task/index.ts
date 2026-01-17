import z from "zod"

export namespace Task {
  export const Status = z.enum(["open", "in_progress", "blocked", "deferred", "closed"])
  export type Status = z.infer<typeof Status>

  export const Lane = z.enum(["session", "repo"])
  export type Lane = z.infer<typeof Lane>

  export const Priority = z.number().int().min(0).max(4)
  export type Priority = z.infer<typeof Priority>

  export const Info = z
    .object({
      content: z.string().describe("Brief description of the task"),
      status: Status.describe("Current status of the task: open, in_progress, blocked, deferred, closed"),
      priority: Priority.describe("Priority level of the task: 0 (P0) - 4 (P4)"),
      id: z.string().describe("Unique identifier for the task"),
      lane: Lane.optional().describe("Task lane: session (default) or repo"),
      checkpoint: z
        .boolean()
        .optional()
        .describe("Requires explicit approval before marking as closed"),
    })
    .meta({ ref: "Task" })
  export type Info = z.infer<typeof Info>

  export function normalizeStatus(status?: string): Status {
    if (!status) return "open"
    const value = status.trim().toLowerCase()
    switch (value) {
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

  export function isBlockingStatus(status: string) {
    return ["open", "in_progress", "blocked"].includes(normalizeStatus(status))
  }

  export function isDoneStatus(status: string) {
    return ["closed", "deferred"].includes(normalizeStatus(status))
  }

  export function normalize(task: Info): Info {
    return {
      content: task.content,
      id: task.id || task.content,
      status: normalizeStatus(task.status),
      priority: normalizePriority(task.priority),
      lane: normalizeLane(task.lane),
      checkpoint: !!task.checkpoint,
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
}
