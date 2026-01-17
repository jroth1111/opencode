import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import z from "zod"
import { Beads } from "@/beads/client"
import { Task } from "@/task"
import { TaskLabels, uniqueLabels } from "@/task/labels"
import { beadsIssueToTask, taskToBeadsIssue, taskToUI, uiToTask } from "@/task/adapters"
import type { BeadsIssue } from "@/beads/protocol"
import { SessionStatus } from "@/session/status"
import { Question } from "@/question"
import fs from "fs/promises"
import path from "path"
import { Instance } from "@/project/instance"
import { Global } from "@/global"

export namespace Todo {
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

  type SessionTodoState = {
    sessionID: string
    updatedAt: number
    lastRecoveryAt?: number
    agent?: string
    todos: Info[]
  }

  const STALE_IN_PROGRESS_MS = 30 * 60 * 1000

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
      labels: [TaskLabels.session(sessionID)],
      status: "all",
      limit: 0,
      include_templates: false,
      ephemeral: true,
    })
  }
  const externalRef = TaskLabels.sessionExternalRef
  const extractTodoIDFromExternalRef = (ref?: string | null) => TaskLabels.parseExternalRef(ref)?.todoID

  function sessionStatePath(sessionID: string) {
    const base = Instance.project.vcs
      ? path.join(Instance.worktree, ".opencode", "session")
      : path.join(Global.Path.data, "session")
    return path.join(base, `${sessionID}.json`)
  }

  function progressPath(sessionID: string) {
    const base = Instance.project.vcs
      ? path.join(Instance.worktree, ".opencode", "progress")
      : path.join(Global.Path.data, "progress")
    return path.join(base, `${sessionID}.md`)
  }

  async function readState(sessionID: string) {
    const file = sessionStatePath(sessionID)
    const state = await Bun.file(file)
      .json()
      .then((data) => data as SessionTodoState)
      .catch(() => undefined)
    return state
  }

  async function writeState(sessionID: string, state: SessionTodoState) {
    const file = sessionStatePath(sessionID)
    await fs.mkdir(path.dirname(file), { recursive: true })
    await Bun.write(file, JSON.stringify(state, null, 2))
  }

  async function appendProgress(sessionID: string, todos: Info[]) {
    const file = progressPath(sessionID)
    await fs.mkdir(path.dirname(file), { recursive: true })
    const timestamp = new Date().toISOString()
    const lines = todos.map((todo) => {
      const lane = todo.lane ?? "session"
      const flags = [todo.checkpoint ? "checkpoint" : null, lane !== "session" ? lane : null].filter(Boolean)
      const suffix = flags.length ? ` (${flags.join(", ")})` : ""
      return `- [${todo.status}] ${todo.content}${suffix}`
    })
    const entry = [`## ${timestamp}`, ...lines, ""].join("\n")
    await fs.appendFile(file, entry + "\n")
  }

  async function recoverStale(sessionID: string, issues: BeadsIssue[]) {
    const state = await readState(sessionID)
    if (!state) return issues
    const now = Date.now()
    if (state.lastRecoveryAt && now - state.lastRecoveryAt < STALE_IN_PROGRESS_MS) return issues
    if (now - state.updatedAt < STALE_IN_PROGRESS_MS) return issues
    if (SessionStatus.get(sessionID).type !== "idle") return issues

    if (issues.length === 0 && state.todos.length > 0) {
      const labelSession = TaskLabels.session(sessionID)
      const labelAgent = TaskLabels.agent(state.agent)
      await Promise.all(
        state.todos.map((todo) => {
          const labels = uniqueLabels([
            labelSession,
            TaskLabels.todo(todo.id),
            labelAgent,
            todo.checkpoint ? TaskLabels.checkpoint() : undefined,
          ])
          return Beads.create({
            ...taskToBeadsIssue(todo, {
              sessionID,
              agent: state.agent,
              externalRef: externalRef(sessionID, todo.id),
            }),
            labels,
            ephemeral: true,
          }).catch(() => {})
        }),
      )
      return listSessionIssues(sessionID)
    }

    const staleIssues = issues.filter((issue) => Task.normalizeStatus(issue.status) === "in_progress")
    if (staleIssues.length === 0) return issues

    await Promise.all(
      staleIssues.map((issue) =>
        Beads.update({
          id: issue.id,
          status: "open",
        }).catch(() => {}),
      ),
    )

    const staleTodoIDs = new Set(
      staleIssues
        .map((issue) => TaskLabels.extractTodoID(issue.labels) ?? extractTodoIDFromExternalRef(issue.external_ref))
        .filter(Boolean) as string[],
    )

    const updatedTodos: Info[] = state.todos.map((todo) =>
      staleTodoIDs.has(todo.id)
        ? {
            ...todo,
            status: "open",
          }
        : todo,
    )

    await writeState(sessionID, {
      ...state,
      todos: updatedTodos,
      updatedAt: now,
      lastRecoveryAt: now,
    }).catch(() => {})

    return issues.map((issue) =>
      staleTodoIDs.has(TaskLabels.extractTodoID(issue.labels) ?? extractTodoIDFromExternalRef(issue.external_ref) ?? "")
        ? { ...issue, status: "open" }
        : issue,
    )
  }

  async function applyCheckpointGate(input: {
    sessionID: string
    todos: Info[]
    existingByTodo: Map<string, BeadsIssue>
    tool?: { messageID: string; callID?: string }
  }) {
    const pending = input.todos.filter((todo) => {
      if (!todo.checkpoint) return false
      if (Task.normalizeStatus(todo.status) !== "closed") return false
      const existing = input.existingByTodo.get(todo.id)
      if (!existing) return true
      return Task.normalizeStatus(existing.status) !== "closed"
    })

    if (pending.length === 0) return input.todos

    const questions = pending.map((todo) => ({
      header: "Checkpoint",
      question: `Approve completion of this checkpoint task?\n${todo.content}`,
      options: [
        { label: "Complete", description: "Mark this task as closed" },
        { label: "Keep open", description: "Leave this task open for follow-up" },
      ],
      multiple: false,
      custom: false,
    }))

    let answers: Question.Answer[] = []
    try {
      answers = await Question.ask({
        sessionID: input.sessionID,
        questions,
        tool: input.tool?.callID ? { messageID: input.tool.messageID, callID: input.tool.callID } : undefined,
      })
    } catch {
      answers = []
    }

    const decisions = new Map<string, boolean>()
    pending.forEach((todo, index) => {
      const answer = answers[index] ?? []
      const approved = answer.includes("Complete")
      decisions.set(todo.id, approved)
    })

    return input.todos.map((todo) => {
      if (!decisions.has(todo.id)) return todo
      if (decisions.get(todo.id)) return todo
      const existing = input.existingByTodo.get(todo.id)
      const fallback = existing ? Task.normalizeStatus(existing.status) : "blocked"
      return {
        ...todo,
        status: fallback === "closed" ? "blocked" : fallback,
      }
    })
  }

  export async function update(input: {
    sessionID: string
    todos: Info[]
    agent?: string
    tool?: { messageID: string; callID?: string }
  }) {
    const todos = input.todos.map(normalizeTodo)
    const existing = await listSessionIssues(input.sessionID)
    const existingByTodo = new Map<string, BeadsIssue>()
    for (const issue of existing) {
      const todoID = TaskLabels.extractTodoID(issue.labels) ?? extractTodoIDFromExternalRef(issue.external_ref)
      if (todoID) existingByTodo.set(todoID, issue)
    }

    const seen = new Set<string>()
    const labelSession = TaskLabels.session(input.sessionID)
    const labelAgent = TaskLabels.agent(input.agent)
    const gatedTodos = await applyCheckpointGate({
      sessionID: input.sessionID,
      todos,
      existingByTodo,
      tool: input.tool,
    })

    for (const todo of gatedTodos) {
      const labelTodo = TaskLabels.todo(todo.id)
      const existingIssue = existingByTodo.get(todo.id)
      const ref = externalRef(input.sessionID, todo.id)
      const base = taskToBeadsIssue(todo, { sessionID: input.sessionID, agent: input.agent, externalRef: ref })
      const labels = uniqueLabels([
        labelSession,
        labelTodo,
        labelAgent,
        todo.checkpoint ? TaskLabels.checkpoint() : undefined,
      ])
      const removeLabels =
        labelAgent && existingIssue?.labels
          ? existingIssue.labels.filter(
              (label) => label.startsWith(TaskLabels.prefixes.agent) && label !== labelAgent,
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
      const todoID = TaskLabels.extractTodoID(issue.labels) ?? extractTodoIDFromExternalRef(issue.external_ref)
      if (!todoID || seen.has(todoID)) continue
      if (Task.normalizeStatus(issue.status) !== "closed") {
        await Beads.update({
          id: issue.id,
          status: "closed",
        })
      }
    }

    await writeState(input.sessionID, {
      sessionID: input.sessionID,
      agent: input.agent,
      updatedAt: Date.now(),
      todos: gatedTodos,
    }).catch(() => {})
    await appendProgress(input.sessionID, gatedTodos).catch(() => {})

    Bus.publish(Event.Updated, { sessionID: input.sessionID, todos: gatedTodos })
  }

  export async function get(sessionID: string) {
    const issues = await listSessionIssues(sessionID).then((result) => recoverStale(sessionID, result))
    const todos = issues
      .map((issue) => {
        const todoID = TaskLabels.extractTodoID(issue.labels) ?? extractTodoIDFromExternalRef(issue.external_ref)
        return taskToUI(beadsIssueToTask(issue, { id: todoID }))
      })
      .sort(sortTodos)
    return todos
  }
}
