import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import z from "zod"
import { Storage } from "../storage/storage"
import { Beads, type BeadsIssue } from "@/beads/client"
import { Log } from "@/util/log"
import { Task } from "@/task"

export namespace Todo {
  const log = Log.create({ service: "session.todo" })
  const SESSION_LABEL_PREFIX = "opencode:session:"
  const TODO_LABEL_PREFIX = "opencode:todo:"
  const EXTERNAL_REF_PREFIX = "opencode:session:"

  export const Info = Task.Info
  export type Info = Task.Info

  export const Event = {
    Updated: BusEvent.define(
      "todo.updated",
      z.object({
        sessionID: z.string(),
        todos: z.array(Info),
      }),
    ),
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

  function toBeadsPriority(priority?: string) {
    const normalized = Task.normalizePriority(priority)
    if (normalized === "high") return 1
    if (normalized === "low") return 3
    return 2
  }

  function toTodoPriority(priority?: number): Task.Priority {
    if (priority === undefined) return "medium"
    if (priority <= 1) return "high"
    if (priority === 2) return "medium"
    return "low"
  }

  function normalizeTodo(todo: Info): Info {
    return Task.normalize(todo)
  }

  function sortTodos(a: Info, b: Info) {
    const order: Record<string, number> = {
      in_progress: 0,
      open: 1,
      blocked: 2,
      deferred: 3,
      closed: 4,
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

  function externalRef(sessionID: string, todoID: string) {
    return `${EXTERNAL_REF_PREFIX}${encodeLabel(sessionID)}:todo:${encodeLabel(todoID)}`
  }

  function extractTodoIDFromExternalRef(ref?: string | null) {
    if (!ref || !ref.startsWith(EXTERNAL_REF_PREFIX)) return
    const tail = ref.slice(EXTERNAL_REF_PREFIX.length)
    const [rawSession, marker, rawTodo] = tail.split(":")
    if (!rawSession || marker !== "todo" || !rawTodo) return
    return decodeLabel(rawTodo)
  }

  export async function update(input: { sessionID: string; todos: Info[] }) {
    const todos = input.todos.map(normalizeTodo)
    try {
      const existing = await listSessionIssues(input.sessionID)
      const existingByTodo = new Map<string, BeadsIssue>()
      for (const issue of existing) {
        const todoID = extractTodoID(issue.labels) ?? extractTodoIDFromExternalRef(issue.external_ref)
        if (todoID) existingByTodo.set(todoID, issue)
      }

      const seen = new Set<string>()
      for (const todo of todos) {
        const labelSession = sessionLabel(input.sessionID)
        const labelTodo = todoLabel(todo.id)
        const existingIssue = existingByTodo.get(todo.id)
        const ref = externalRef(input.sessionID, todo.id)
        if (existingIssue) {
          await Beads.update({
            id: existingIssue.id,
            title: todo.content,
            status: Task.normalizeStatus(todo.status),
            priority: toBeadsPriority(todo.priority),
            add_labels: [labelSession, labelTodo],
            external_ref: ref,
          })
        } else {
          await Beads.create({
            title: todo.content,
            issue_type: "task",
            priority: toBeadsPriority(todo.priority),
            labels: [labelSession, labelTodo],
            ephemeral: true,
            external_ref: ref,
          })
        }
        seen.add(todo.id)
      }

      for (const issue of existing) {
        const todoID = extractTodoID(issue.labels) ?? extractTodoIDFromExternalRef(issue.external_ref)
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
          id: extractTodoID(issue.labels) ?? extractTodoIDFromExternalRef(issue.external_ref) ?? issue.id,
          content: issue.title,
          status: Task.normalizeStatus(issue.status),
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
