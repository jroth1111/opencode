import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import z from "zod"
import { Beads } from "@/beads/client"
import { Task } from "@/task"
import { beadsIssueToTask, taskToBeadsIssue, taskToUI, uiToTask } from "@/task/adapters"
import type { BeadsIssue } from "@/beads/protocol"

export namespace Todo {
  const SESSION_LABEL_PREFIX = "opencode:session:"
  const TODO_LABEL_PREFIX = "opencode:todo:"
  const AGENT_LABEL_PREFIX = "opencode:agent:"
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

  function agentLabel(agent?: string) {
    if (!agent) return
    return `${AGENT_LABEL_PREFIX}${encodeLabel(agent)}`
  }

  function extractTodoID(labels?: string[]) {
    if (!labels) return
    const match = labels.find((label) => label.startsWith(TODO_LABEL_PREFIX))
    if (!match) return
    return decodeLabel(match.slice(TODO_LABEL_PREFIX.length))
  }

  function normalizeTodo(todo: Info): Info {
    return uiToTask(todo)
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

  export async function update(input: { sessionID: string; todos: Info[]; agent?: string }) {
    const todos = input.todos.map(normalizeTodo)
    const existing = await listSessionIssues(input.sessionID)
    const existingByTodo = new Map<string, BeadsIssue>()
    for (const issue of existing) {
      const todoID = extractTodoID(issue.labels) ?? extractTodoIDFromExternalRef(issue.external_ref)
      if (todoID) existingByTodo.set(todoID, issue)
    }

    const seen = new Set<string>()
    const labelSession = sessionLabel(input.sessionID)
    const labelAgent = agentLabel(input.agent)
    for (const todo of todos) {
      const labelTodo = todoLabel(todo.id)
      const existingIssue = existingByTodo.get(todo.id)
      const ref = externalRef(input.sessionID, todo.id)
      const base = taskToBeadsIssue(todo, { sessionID: input.sessionID, agent: input.agent, externalRef: ref })
      const labels = [labelSession, labelTodo, ...(labelAgent ? [labelAgent] : [])]
      const removeLabels =
        labelAgent && existingIssue?.labels
          ? existingIssue.labels.filter((label) => label.startsWith(AGENT_LABEL_PREFIX) && label !== labelAgent)
          : undefined

      if (existingIssue) {
        await Beads.update({
          id: existingIssue.id,
          ...base,
          add_labels: labels,
          remove_labels: removeLabels,
        })
      } else {
        await Beads.create({
          ...base,
          labels,
          ephemeral: true,
        })
      }
      seen.add(todo.id)
    }

    for (const issue of existing) {
      const todoID = extractTodoID(issue.labels) ?? extractTodoIDFromExternalRef(issue.external_ref)
      if (!todoID || seen.has(todoID)) continue
      if (Task.normalizeStatus(issue.status) !== "closed") {
        await Beads.update({
          id: issue.id,
          status: "closed",
        })
      }
    }

    Bus.publish(Event.Updated, { sessionID: input.sessionID, todos })
  }

  export async function get(sessionID: string) {
    const issues = await listSessionIssues(sessionID)
    const todos = issues
      .map((issue) => {
        const todoID = extractTodoID(issue.labels) ?? extractTodoIDFromExternalRef(issue.external_ref)
        return taskToUI(beadsIssueToTask(issue, { id: todoID }))
      })
      .sort(sortTodos)
    return todos
  }
}
