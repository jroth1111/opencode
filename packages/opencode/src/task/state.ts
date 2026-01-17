import fs from "fs/promises"
import path from "path"
import { Global } from "@/global"
import { Instance } from "@/project/instance"
import { Task } from "@/task"

type LaneSummary = {
  total: number
  blocking: number
  inProgress: string[]
  blocked: string[]
  ready: number
}

type DigestLane = {
  inProgress: string[]
  blocked: string[]
  next: string[]
  done: string[]
}

export type TaskStateRecord = {
  updatedAt: string
  checkpoint?: {
    snapshot?: string
    updatedAt?: string
  }
  decisions?: string[]
  blockers?: string[]
  digest?: {
    updatedAt: string
    session?: DigestLane
    repo?: DigestLane
  }
  session?: {
    sessionID: string
    agent?: string
    summary: LaneSummary
  }
  repo?: {
    agent?: string
    summary: LaneSummary
  }
}

function statePaths() {
  const base = Instance.project.vcs
    ? path.join(Instance.worktree, ".opencode")
    : Global.Path.data
  return {
    json: path.join(base, "state.json"),
    markdown: path.join(base, "STATE.md"),
  }
}

function normalizeList(items: string[]) {
  return Array.from(new Set(items.filter(Boolean)))
}

function summarizeTodos(todos: Task.Info[]): LaneSummary {
  const byId = new Map(todos.map((todo) => [todo.id, todo]))
  const inProgress = [] as string[]
  const blocked = [] as string[]
  let ready = 0

  const isDone = (todo: Task.Info) => Task.isDoneStatus(todo.status)
  const isBlocking = (todo: Task.Info) => Task.isBlockingStatus(todo.status)
  const hasUnresolvedDeps = (todo: Task.Info) => {
    if (!todo.dependsOn || todo.dependsOn.length === 0) return false
    return todo.dependsOn.some((id) => {
      const dep = byId.get(id)
      if (!dep) return true
      return !isDone(dep)
    })
  }

  for (const todo of todos) {
    if (Task.normalizeStatus(todo.status) === "in_progress") inProgress.push(todo.content)
    if (Task.normalizeStatus(todo.status) === "blocked" || hasUnresolvedDeps(todo)) {
      blocked.push(todo.content)
    }
    if (isBlocking(todo) && !hasUnresolvedDeps(todo) && Task.normalizeStatus(todo.status) === "open") {
      ready++
    }
  }

  return {
    total: todos.length,
    blocking: todos.filter((todo) => isBlocking(todo)).length,
    inProgress: normalizeList(inProgress),
    blocked: normalizeList(blocked),
    ready,
  }
}

function digestTodos(todos: Task.Info[]): DigestLane {
  const byId = new Map(todos.map((todo) => [todo.id, todo]))
  const inProgress: string[] = []
  const blocked: string[] = []
  const next: string[] = []
  const done: string[] = []

  const isDone = (todo: Task.Info) => Task.isDoneStatus(todo.status)
  const hasUnresolvedDeps = (todo: Task.Info) => {
    if (!todo.dependsOn || todo.dependsOn.length === 0) return false
    return todo.dependsOn.some((id) => {
      const dep = byId.get(id)
      if (!dep) return true
      return !isDone(dep)
    })
  }

  for (const todo of todos) {
    const status = Task.normalizeStatus(todo.status)
    const unresolved = hasUnresolvedDeps(todo)
    if (status === "in_progress") inProgress.push(todo.content)
    if (status === "blocked" || unresolved) blocked.push(todo.content)
    if (status === "open" && !unresolved) next.push(todo.content)
    if (Task.isDoneStatus(status)) done.push(todo.content)
  }

  return {
    inProgress: normalizeList(inProgress),
    blocked: normalizeList(blocked),
    next: normalizeList(next),
    done: normalizeList(done),
  }
}

function renderMarkdown(record: TaskStateRecord) {
  const lines: string[] = []
  lines.push("# Task State")
  lines.push("")
  lines.push(`Updated: ${record.updatedAt}`)
  if (record.checkpoint?.snapshot) {
    lines.push(`Last Checkpoint: ${record.checkpoint.snapshot}`)
  }
  lines.push("")

  if (record.session) {
    const summary = record.session.summary
    lines.push("## Session Todos")
    lines.push(`Session: ${record.session.sessionID}`)
    if (record.session.agent) lines.push(`Agent: ${record.session.agent}`)
    lines.push(`Total: ${summary.total}`)
    lines.push(`Blocking: ${summary.blocking}`)
    lines.push(`Ready: ${summary.ready}`)
    if (summary.inProgress.length > 0) {
      lines.push("")
      lines.push("In Progress:")
      summary.inProgress.forEach((item) => lines.push(`- ${item}`))
    }
    if (summary.blocked.length > 0) {
      lines.push("")
      lines.push("Blocked:")
      summary.blocked.forEach((item) => lines.push(`- ${item}`))
    }
    lines.push("")
  }

  if (record.repo) {
    const summary = record.repo.summary
    lines.push("## Repo Todos")
    if (record.repo.agent) lines.push(`Agent: ${record.repo.agent}`)
    lines.push(`Total: ${summary.total}`)
    lines.push(`Blocking: ${summary.blocking}`)
    lines.push(`Ready: ${summary.ready}`)
    if (summary.inProgress.length > 0) {
      lines.push("")
      lines.push("In Progress:")
      summary.inProgress.forEach((item) => lines.push(`- ${item}`))
    }
    if (summary.blocked.length > 0) {
      lines.push("")
      lines.push("Blocked:")
      summary.blocked.forEach((item) => lines.push(`- ${item}`))
    }
  }

  if (record.decisions && record.decisions.length > 0) {
    lines.push("")
    lines.push("Decisions:")
    record.decisions.forEach((item) => lines.push(`- ${item}`))
  }

  if (record.blockers && record.blockers.length > 0) {
    lines.push("")
    lines.push("Blockers:")
    record.blockers.forEach((item) => lines.push(`- ${item}`))
  }

  return lines.join("\n").trim() + "\n"
}

async function readRecord(pathname: string): Promise<TaskStateRecord | undefined> {
  const data = await fs
    .readFile(pathname, "utf8")
    .then((content) => JSON.parse(content) as TaskStateRecord)
    .catch(() => undefined)
  return data
}

async function writeRecord(record: TaskStateRecord) {
  const paths = statePaths()
  await fs.mkdir(path.dirname(paths.json), { recursive: true })
  await fs.writeFile(paths.json, JSON.stringify(record, null, 2))
  await fs.writeFile(paths.markdown, renderMarkdown(record))
}

export namespace TaskState {
  export type Record = TaskStateRecord

  export async function get() {
    const paths = statePaths()
    return readRecord(paths.json)
  }

  export async function updateSession(input: {
    sessionID: string
    agent?: string
    todos: Task.Info[]
    checkpointSnapshot?: string
  }) {
    const paths = statePaths()
    const existing = (await readRecord(paths.json)) ?? { updatedAt: new Date(0).toISOString() }
    const summary = summarizeTodos(input.todos)
    const digest = digestTodos(input.todos)
    const now = new Date().toISOString()
    const record: TaskStateRecord = {
      ...existing,
      updatedAt: now,
      checkpoint: input.checkpointSnapshot
        ? {
            snapshot: input.checkpointSnapshot,
            updatedAt: now,
          }
        : existing.checkpoint,
      decisions: existing.decisions,
      blockers: existing.blockers,
      digest: {
        updatedAt: now,
        session: digest,
        repo: existing.digest?.repo,
      },
      session: {
        sessionID: input.sessionID,
        agent: input.agent,
        summary,
      },
    }
    await writeRecord(record)
  }

  export async function updateRepo(input: { agent?: string; todos: Task.Info[]; checkpointSnapshot?: string }) {
    const paths = statePaths()
    const existing = (await readRecord(paths.json)) ?? { updatedAt: new Date(0).toISOString() }
    const summary = summarizeTodos(input.todos)
    const digest = digestTodos(input.todos)
    const now = new Date().toISOString()
    const record: TaskStateRecord = {
      ...existing,
      updatedAt: now,
      checkpoint: input.checkpointSnapshot
        ? {
            snapshot: input.checkpointSnapshot,
            updatedAt: now,
          }
        : existing.checkpoint,
      decisions: existing.decisions,
      blockers: existing.blockers,
      digest: {
        updatedAt: now,
        session: existing.digest?.session,
        repo: digest,
      },
      repo: {
        agent: input.agent,
        summary,
      },
    }
    await writeRecord(record)
  }

  export async function updateNotes(input: { decisions?: string[]; blockers?: string[] }) {
    const paths = statePaths()
    const existing = (await readRecord(paths.json)) ?? { updatedAt: new Date(0).toISOString() }
    const record: TaskStateRecord = {
      ...existing,
      updatedAt: new Date().toISOString(),
      decisions: input.decisions ?? existing.decisions,
      blockers: input.blockers ?? existing.blockers,
    }
    await writeRecord(record)
  }
}
