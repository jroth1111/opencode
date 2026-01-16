import z from "zod"

export namespace Task {
  export const Status = z.enum(["open", "in_progress", "blocked", "deferred", "closed"])
  export type Status = z.infer<typeof Status>

  export const Priority = z.enum(["high", "medium", "low"])
  export type Priority = z.infer<typeof Priority>

  export const Info = z
    .object({
      content: z.string().describe("Brief description of the task"),
      status: Status.describe("Current status of the task: open, in_progress, blocked, deferred, closed"),
      priority: Priority.describe("Priority level of the task: high, medium, low"),
      id: z.string().describe("Unique identifier for the task"),
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
      case "cancelled":
        return "deferred"
      default:
        return "open"
    }
  }

  export function normalizePriority(priority?: string): Priority {
    if (!priority) return "medium"
    const value = priority.trim().toLowerCase()
    if (value === "high" || value === "medium" || value === "low") return value
    return "medium"
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
    }
  }
}
