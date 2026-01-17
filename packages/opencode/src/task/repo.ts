import { Beads } from "@/beads/client"
import { Instance } from "@/project/instance"
import { Task } from "@/task"
import { TaskLabels, uniqueLabels } from "@/task/labels"
import { beadsIssueToTask, taskToBeadsIssue } from "@/task/adapters"
import type { BeadsIssue } from "@/beads/protocol"

export namespace RepoTodo {
  export const Info = Task.Info
  export type Info = Task.Info

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

  function repoLabel() {
    return TaskLabels.repo(Instance.project.id)
  }

  function agentLabel(agent?: string) {
    return TaskLabels.agent(agent)
  }

  function todoIDFromIssue(issue: BeadsIssue) {
    return TaskLabels.extractTodoID(issue.labels) ?? TaskLabels.parseExternalRef(issue.external_ref)?.todoID
  }

  function normalizeTodo(todo: Info): Info {
    return Task.normalize(todo)
  }

  export async function list(input?: { agent?: string; status?: string; limit?: number }) {
    const labels = uniqueLabels([repoLabel(), agentLabel(input?.agent)])
    const issues = await Beads.list({
      labels,
      status: input?.status ?? "all",
      limit: input?.limit ?? 0,
      include_templates: false,
      ephemeral: false,
    })
    return issues
      .map((issue) => {
        const todoID = todoIDFromIssue(issue)
        return beadsIssueToTask(issue, { id: todoID })
      })
      .sort(sortTodos)
  }

  export async function ready(input?: { agent?: string; limit?: number }) {
    const labels = uniqueLabels([repoLabel(), agentLabel(input?.agent)])
    const issues = await Beads.ready({
      labels,
      limit: input?.limit ?? 10,
    })
    return issues
      .map((issue) => {
        const todoID = todoIDFromIssue(issue)
        return beadsIssueToTask(issue, { id: todoID })
      })
      .sort(sortTodos)
  }

  export async function upsert(input: { sessionID?: string; agent?: string; todos: Info[] }) {
    const todos = input.todos.map(normalizeTodo)
    const labelsBase = uniqueLabels([repoLabel(), agentLabel(input.agent)])
    const existing = await Beads.list({
      labels: labelsBase,
      status: "all",
      limit: 0,
      include_templates: false,
      ephemeral: false,
    })

    const existingByTodo = new Map<string, BeadsIssue>()
    for (const issue of existing) {
      const todoID = todoIDFromIssue(issue)
      if (todoID) existingByTodo.set(todoID, issue)
    }

    for (const todo of todos) {
      const labelTodo = TaskLabels.todo(todo.id)
      const existingIssue = existingByTodo.get(todo.id)
      const ref = TaskLabels.repoExternalRef(Instance.project.id, todo.id)
      const base = taskToBeadsIssue(todo, { agent: input.agent, externalRef: ref })
      const labels = uniqueLabels([
        repoLabel(),
        labelTodo,
        agentLabel(input.agent),
        todo.checkpoint ? TaskLabels.checkpoint() : undefined,
      ])
      const removeLabels =
        input.agent && existingIssue?.labels
          ? existingIssue.labels.filter(
              (label) => label.startsWith(TaskLabels.prefixes.agent) && label !== agentLabel(input.agent),
            )
          : undefined
      const removeCheckpoint =
        !todo.checkpoint && existingIssue?.labels?.includes(TaskLabels.prefixes.checkpoint)
          ? [TaskLabels.prefixes.checkpoint]
          : []
      const combinedRemove = uniqueLabels([...(removeLabels ?? []), ...removeCheckpoint])

      if (existingIssue) {
        await Beads.update({
          id: existingIssue.id,
          ...base,
          add_labels: labels,
          remove_labels: combinedRemove.length ? combinedRemove : undefined,
        })

        const prevStatus = Task.normalizeStatus(existingIssue.status)
        const nextStatus = Task.normalizeStatus(todo.status)
        if (prevStatus !== nextStatus && Task.isDoneStatus(nextStatus)) {
          const author = input.agent ?? "opencode"
          const sessionNote = input.sessionID ? ` (session ${input.sessionID})` : ""
          const text = `Status updated to ${nextStatus}${sessionNote}.`
          await Beads.comments.add({
            id: existingIssue.id,
            author,
            text,
          }).catch(() => {})
        }
      } else {
        const created = await Beads.create({
          ...base,
          labels,
          ephemeral: false,
        })
        const nextStatus = Task.normalizeStatus(todo.status)
        if (Task.isDoneStatus(nextStatus)) {
          const author = input.agent ?? "opencode"
          const sessionNote = input.sessionID ? ` (session ${input.sessionID})` : ""
          const text = `Created as ${nextStatus}${sessionNote}.`
          await Beads.comments
            .add({
              id: created.id,
              author,
              text,
            })
            .catch(() => {})
        }
      }
    }
  }
}

