import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import z from "zod"
import { Storage } from "../storage/storage"
import { Beads, type BeadsIssue } from "@/beads/client"
import { Log } from "@/util/log"

export namespace Todo {
  const log = Log.create({ service: "session.todo" })
  const SESSION_LABEL_PREFIX = "opencode:session:"
  const TODO_LABEL_PREFIX = "opencode:todo:"
  const STATUS_PENDING = "pending"
  const STATUS_IN_PROGRESS = "in_progress"
  const STATUS_BLOCKED = "blocked"
  const STATUS_DEFERRED = "deferred"
  const STATUS_COMPLETED = "completed"
  const STATUS_CANCELLED = "cancelled"

  export const Info = z
    .object({
      content: z.string().describe("Brief description of the task"),
      status: z
        .string()
        .describe(
          "Current status of the task: pending, in_progress, blocked, deferred, completed, cancelled",
        ),
      priority: z.string().describe("Priority level of the task: high, medium, low"),
      id: z.string().describe("Unique identifier for the todo item"),
    })
    .meta({ ref: "Todo" })
  export type Info = z.infer<typeof Info>

  export const Event = {
    Updated: BusEvent.define(
      "todo.updated",
      z.object({
        sessionID: z.string(),
        todos: z.array(Info),
      }),
    ),
  }

  export function isBlockingStatus(status: string) {
    return [STATUS_PENDING, STATUS_IN_PROGRESS, STATUS_BLOCKED].includes(status)
  }

  export function isDoneStatus(status: string) {
    return [STATUS_COMPLETED, STATUS_CANCELLED, STATUS_DEFERRED].includes(status)
  }

  function encodeLabel(value: string) {
    return encodeURIComponent(value)
  }

  function decodeLabel(value: string) {
    try {
      return decodeURIComponent(value)
    } catch {
      return value
    }
  }

  function sessionLabel(sessionID: string) {
    return `${SESSION_LABEL_PREFIX}${encodeLabel(sessionID)}`
  }

  function todoLabel(todoID: string) {
    return `${TODO_LABEL_PREFIX}${encodeLabel(todoID)}`
  }

  function extractTodoID(labels?: string[]) {
    if (!labels) return
    const match = labels.find((label) => label.startsWith(TODO_LABEL_PREFIX))
    if (!match) return
    return decodeLabel(match.slice(TODO_LABEL_PREFIX.length))
  }

  function normalizeStatus(status?: string): Info["status"] {
    if (!status) return STATUS_PENDING
    const value = status.trim().toLowerCase()
    switch (value) {
      case STATUS_PENDING:
      case STATUS_IN_PROGRESS:
      case STATUS_BLOCKED:
      case STATUS_DEFERRED:
      case STATUS_COMPLETED:
      case STATUS_CANCELLED:
        return value
      default:
        return STATUS_PENDING
    }
  }

  function normalizePriority(priority?: string): Info["priority"] {
    if (!priority) return "medium"
    const value = priority.trim().toLowerCase()
    if (value === "high" || value === "medium" || value === "low") return value
    return "medium"
  }

  function toBeadsStatus(status?: string) {
    switch (normalizeStatus(status)) {
      case STATUS_PENDING:
        return "open"
      case STATUS_IN_PROGRESS:
        return "in_progress"
      case STATUS_BLOCKED:
        return "blocked"
      case STATUS_DEFERRED:
        return "deferred"
      case STATUS_COMPLETED:
        return "closed"
      case STATUS_CANCELLED:
        return "deferred"
      default:
        return "open"
    }
  }

  function toTodoStatus(status?: string): Info["status"] {
    switch ((status ?? "").toLowerCase()) {
      case "open":
        return STATUS_PENDING
      case "in_progress":
        return STATUS_IN_PROGRESS
      case "blocked":
        return STATUS_BLOCKED
      case "deferred":
        return STATUS_DEFERRED
      case "closed":
        return STATUS_COMPLETED
      case "tombstone":
        return STATUS_CANCELLED
      default:
        return STATUS_PENDING
    }
  }

  function toBeadsPriority(priority?: string) {
    const normalized = normalizePriority(priority)
    if (normalized === "high") return 1
    if (normalized === "low") return 3
    return 2
  }

  function toTodoPriority(priority?: number): Info["priority"] {
    if (priority === undefined) return "medium"
    if (priority <= 1) return "high"
    if (priority === 2) return "medium"
    return "low"
  }

  function normalizeTodo(todo: Info): Info {
    return {
      content: todo.content,
      id: todo.id || todo.content,
      status: normalizeStatus(todo.status),
      priority: normalizePriority(todo.priority),
    }
  }

  function sortTodos(a: Info, b: Info) {
    const order: Record<string, number> = {
      [STATUS_IN_PROGRESS]: 0,
      [STATUS_PENDING]: 1,
      [STATUS_BLOCKED]: 2,
      [STATUS_DEFERRED]: 3,
      [STATUS_COMPLETED]: 4,
      [STATUS_CANCELLED]: 5,
    }
    const rankA = order[a.status] ?? 9
    const rankB = order[b.status] ?? 9
    if (rankA !== rankB) return rankA - rankB
    return a.content.localeCompare(b.content)
  }

  async function listSessionIssues(sessionID: string) {
    return Beads.list({
      labels: [sessionLabel(sessionID)],
      status: "all",
      limit: 0,
      include_templates: false,
      ephemeral: true,
    })
  }

  export async function update(input: { sessionID: string; todos: Info[] }) {
    const todos = input.todos.map(normalizeTodo)
    try {
      const existing = await listSessionIssues(input.sessionID)
      const existingByTodo = new Map<string, BeadsIssue>()
      for (const issue of existing) {
        const todoID = extractTodoID(issue.labels)
        if (todoID) existingByTodo.set(todoID, issue)
      }

      const seen = new Set<string>()
      for (const todo of todos) {
        const labelSession = sessionLabel(input.sessionID)
        const labelTodo = todoLabel(todo.id)
        const existingIssue = existingByTodo.get(todo.id)
        if (existingIssue) {
          await Beads.update({
            id: existingIssue.id,
            title: todo.content,
            status: toBeadsStatus(todo.status),
            priority: toBeadsPriority(todo.priority),
            add_labels: [labelSession, labelTodo],
          })
        } else {
          await Beads.create({
            title: todo.content,
            issue_type: "task",
            priority: toBeadsPriority(todo.priority),
            labels: [labelSession, labelTodo],
            ephemeral: true,
          })
        }
        seen.add(todo.id)
      }

      for (const issue of existing) {
        const todoID = extractTodoID(issue.labels)
        if (!todoID || seen.has(todoID)) continue
        if ((issue.status ?? "").toLowerCase() !== "closed") {
          await Beads.update({
            id: issue.id,
            status: "closed",
          })
        }
      }
    } catch (error) {
      log.warn("beads update failed, falling back to storage", { error })
      await Storage.write(["todo", input.sessionID], todos)
    }
    Bus.publish(Event.Updated, { sessionID: input.sessionID, todos })
  }

  export async function get(sessionID: string) {
    try {
      const issues = await listSessionIssues(sessionID)
      const todos = issues
        .map((issue) => ({
          id: extractTodoID(issue.labels) ?? issue.id,
          content: issue.title,
          status: toTodoStatus(issue.status),
          priority: toTodoPriority(issue.priority),
        }))
        .map(normalizeTodo)
        .sort(sortTodos)
      return todos
    } catch (error) {
      log.warn("beads read failed, falling back to storage", { error })
      return Storage.read<Info[]>(["todo", sessionID])
        .then((x) => x || [])
        .catch(() => [])
    }
  }
}
