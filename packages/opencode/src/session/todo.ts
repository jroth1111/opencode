import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import z from "zod"
import { Beads } from "@/beads/client"
import { Task } from "@/task"
import { TaskLabels, uniqueLabels } from "@/task/labels"
import { beadsIssueToTask, taskToBeadsIssue, taskToUI, uiToTask } from "@/task/adapters"
import { TaskHistory } from "@/task/history"
import { TaskState } from "@/task/state"
import { Config } from "@/config/config"
import { Snapshot } from "@/snapshot"
import { TaskMetrics } from "@/task/metrics"
import type { BeadsIssue } from "@/beads/protocol"
import { SessionStatus } from "@/session/status"
import { Question } from "@/question"
import { TaskRun } from "@/task/run"
import { TaskMutation } from "@/task/mutation"
import { CapabilityToken } from "@/task/capability"
import fs from "fs/promises"
import path from "path"
import { Instance } from "@/project/instance"
import { Global } from "@/global"
import { $ } from "bun"

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

  type ActiveTodo = {
    id: string
    lane: Task.Lane
    status?: Task.Status
    runId?: string
    updatedAt: number
  }

  type CompletionState = {
    done: boolean
    blocking: number
    updatedAt: number
  }

  type SessionTodoState = {
    sessionID: string
    updatedAt: number
    lastRecoveryAt?: number
    agent?: string
    todos: Info[]
    iteration?: number
    active?: ActiveTodo[]
    completion?: CompletionState
  }

  type SessionIndexEntry = {
    sessionID: string
    updatedAt: number
    iteration?: number
    activeTodoIds?: string[]
    completion?: CompletionState
  }

  type SessionIndexRecord = {
    updatedAt: number
    sessions: Record<string, SessionIndexEntry>
  }

  const STALE_IN_PROGRESS_MS = 30 * 60 * 1000
  const DEFAULT_SESSION_WAVE_SIZE = 3

  let cachedCommit: { value?: string; updatedAt: number } | undefined

  async function currentCommit() {
    if (Instance.project.vcs !== "git") return
    const now = Date.now()
    if (cachedCommit && cachedCommit.value && now - cachedCommit.updatedAt < 30_000) {
      return cachedCommit.value
    }
    const value = await $`git rev-parse HEAD`
      .quiet()
      .nothrow()
      .cwd(Instance.worktree)
      .text()
      .then((text) => text.trim())
      .catch(() => undefined)
    cachedCommit = { value, updatedAt: now }
    return value
  }

  export type TodoPatch = Pick<
    Task.Info,
    "status" | "blocks" | "dependsOn" | "files" | "action" | "verify" | "done" | "issueType" | "tracker"
  >

  const SCOPED_PATCH_FIELDS: Array<keyof TodoPatch> = ["status", "blocks", "dependsOn", "action", "verify", "done"]

  function normalizeTodo(todo: Info): Info {
    return uiToTask(todo)
  }

  function applyAssignee(todo: Info, agent?: string) {
    if (!agent || todo.assignee) return todo
    return { ...todo, assignee: agent }
  }

  function applyTracker(todo: Info) {
    if (todo.tracker?.id) return todo
    return {
      ...todo,
      tracker: {
        id: "beads",
        mode: "session",
      },
    }
  }

  function normalizeDependencyIds(ids?: string[]) {
    if (!ids || ids.length === 0) return []
    return Array.from(
      new Set(
        ids
          .map((id) => id?.toString().trim())
          .filter((id): id is string => !!id),
      ),
    )
  }

  function hasUnresolvedDeps(todo: Info, byId: Map<string, Info>) {
    if (!todo.dependsOn || todo.dependsOn.length === 0) return false
    return todo.dependsOn.some((id) => {
      const dep = byId.get(id)
      if (!dep) return true
      return !Task.isDoneStatus(dep.status)
    })
  }

  function applySingleActive(todos: Info[]) {
    const inProgress = todos.filter((todo) => Task.normalizeStatus(todo.status) === "in_progress")
    if (inProgress.length <= 1) return todos
    const byId = new Map(todos.map((todo) => [todo.id, todo]))
    const sorted = inProgress.sort((a, b) => {
      const readyA = hasUnresolvedDeps(a, byId) ? 1 : 0
      const readyB = hasUnresolvedDeps(b, byId) ? 1 : 0
      if (readyA !== readyB) return readyA - readyB
      const pa = Task.normalizePriority(a.priority)
      const pb = Task.normalizePriority(b.priority)
      if (pa !== pb) return pa - pb
      return a.content.localeCompare(b.content)
    })
    const activeId = sorted[0]?.id
    if (!activeId) return todos
    return todos.map((todo) => {
      if (todo.id !== activeId && Task.normalizeStatus(todo.status) === "in_progress") {
        return { ...todo, status: "open" }
      }
      return todo
    })
  }

  function applyWaveLimit(todos: Info[], maxBlocking: number) {
    if (!maxBlocking || maxBlocking <= 0) return todos
    const blocking = todos.filter((todo) => Task.isBlockingStatus(todo.status))
    if (blocking.length <= maxBlocking) return todos
    const byId = new Map(todos.map((todo) => [todo.id, todo]))
    const ranked = blocking.sort((a, b) => {
      const statusRank = (todo: Info) => {
        const status = Task.normalizeStatus(todo.status)
        const unresolved = hasUnresolvedDeps(todo, byId)
        if (status === "in_progress") return 0
        if (status === "open" && !unresolved) return 1
        if (status === "open") return 2
        if (status === "blocked") return 3
        return 4
      }
      const rankA = statusRank(a)
      const rankB = statusRank(b)
      if (rankA !== rankB) return rankA - rankB
      const pa = Task.normalizePriority(a.priority)
      const pb = Task.normalizePriority(b.priority)
      if (pa !== pb) return pa - pb
      return a.content.localeCompare(b.content)
    })
    const keep = new Set(ranked.slice(0, maxBlocking).map((todo) => todo.id))
    return todos.map((todo) => {
      if (!keep.has(todo.id) && Task.isBlockingStatus(todo.status)) {
        return { ...todo, status: "deferred" }
      }
      return todo
    })
  }

  function applyPatch(todo: Info, patch: Partial<TodoPatch>) {
    return {
      ...todo,
      status: patch.status ?? todo.status,
      blocks: patch.blocks ?? todo.blocks,
      dependsOn: patch.dependsOn ?? todo.dependsOn,
      files: patch.files ?? todo.files,
      action: patch.action ?? todo.action,
      verify: patch.verify ?? todo.verify,
      done: patch.done ?? todo.done,
      issueType: patch.issueType ?? todo.issueType,
      tracker: patch.tracker ?? todo.tracker,
    }
  }

  function expectedMatches(todo: Info, expected?: Partial<TodoPatch>, patch?: Partial<TodoPatch>) {
    if (!expected || !patch) return false
    const fields = SCOPED_PATCH_FIELDS
    for (const field of fields) {
      if (patch[field] === undefined) continue
      if (expected[field] === undefined) return false
      const current = todo[field]
      const exp = expected[field]
      if (Array.isArray(current) || Array.isArray(exp)) {
        const currentList = Array.isArray(current) ? current : []
        const expectedList = Array.isArray(exp) ? exp : []
        if (currentList.join("|") !== expectedList.join("|")) return false
      } else if (current && exp && typeof current === "object" && typeof exp === "object") {
        if (JSON.stringify(current) !== JSON.stringify(exp)) return false
      } else if (current !== exp) {
        return false
      }
    }
    return true
  }

  function filterScopedPatch(patch: Partial<TodoPatch>) {
    const allowed: Partial<TodoPatch> = {}
    for (const field of SCOPED_PATCH_FIELDS) {
      if (patch[field] !== undefined) allowed[field] = patch[field]
    }
    const disallowed = Object.keys(patch).filter((field) => !(SCOPED_PATCH_FIELDS as string[]).includes(field))
    return { allowed, disallowed }
  }

  function resolveDependencyIds(
    ids: string[] | undefined,
    maps: { todoToIssue: Map<string, string>; issueIds: Set<string> },
  ) {
    const resolved = normalizeDependencyIds(ids)
      .map((raw) => {
        const trimmed = raw.trim()
        const prefixed = trimmed.match(/^(?:beads|external):(.+)$/i)
        if (prefixed?.[1]) return prefixed[1]
        const mapped = maps.todoToIssue.get(trimmed)
        if (mapped) return mapped
        if (maps.issueIds.has(trimmed)) return trimmed
        return undefined
      })
      .filter((id): id is string => !!id)
    return Array.from(new Set(resolved))
  }

  function extractBlocksDependencies(issue: BeadsIssue) {
    return (
      issue.dependencies
        ?.filter((dep) => !dep.dependency_type || dep.dependency_type === "blocks")
        .map((dep) => dep.id) ?? []
    )
  }

  async function syncDependencies(issue: BeadsIssue, desired: string[]) {
    const existing = extractBlocksDependencies(issue)
    const desiredSet = new Set(desired)
    const existingSet = new Set(existing)
    const add = desired.filter((id) => !existingSet.has(id))
    const remove = existing.filter((id) => !desiredSet.has(id))
    await Promise.all([
      ...add.map((id) =>
        Beads.deps.add({ from_id: issue.id, to_id: id, dep_type: "blocks" }).catch(() => {}),
      ),
      ...remove.map((id) =>
        Beads.deps.remove({ from_id: issue.id, to_id: id, dep_type: "blocks" }).catch(() => {}),
      ),
    ])
  }

  function sortTodos(a: Info, b: Info) {
    const order: Record<string, number> = {
      in_progress: 0,
      open: 1,
      blocked: 2,
      deferred: 3,
      draft: 4,
      closed: 5,
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

  function sessionIndexPath() {
    const base = Instance.project.vcs ? path.join(Instance.worktree, ".opencode") : Global.Path.data
    return path.join(base, "session.json")
  }

  async function readSessionIndex() {
    const file = sessionIndexPath()
    const data = await Bun.file(file)
      .json()
      .then((payload) => payload as SessionIndexRecord)
      .catch(() => undefined)
    return data ?? { updatedAt: 0, sessions: {} }
  }

  async function writeSessionIndex(next: SessionIndexRecord) {
    const file = sessionIndexPath()
    await fs.mkdir(path.dirname(file), { recursive: true })
    await Bun.write(file, JSON.stringify(next, null, 2))
  }

  async function updateSessionIndex(entry: SessionIndexEntry) {
    const record = await readSessionIndex()
    const next: SessionIndexRecord = {
      updatedAt: Date.now(),
      sessions: {
        ...record.sessions,
        [entry.sessionID]: entry,
      },
    }
    await writeSessionIndex(next)
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
    const commit = await currentCommit().catch(() => undefined)
    const lines = todos.map((todo) => {
      const lane = todo.lane ?? "session"
      const flags = [todo.checkpoint ? "checkpoint" : null, lane !== "session" ? lane : null].filter(Boolean)
      const suffix = flags.length ? ` (${flags.join(", ")})` : ""
      return `- [${todo.status}] ${todo.content}${suffix}`
    })
    const header = commit ? `## ${timestamp} (commit ${commit})` : `## ${timestamp}`
    const entry = [header, ...lines, ""].join("\n")
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
      await Promise.all(
        state.todos.map((todo) => {
          const assigneeLabel = TaskLabels.agent(todo.assignee ?? state.agent)
          const labels = uniqueLabels([
            labelSession,
            TaskLabels.todo(todo.id),
            assigneeLabel,
            todo.checkpoint ? TaskLabels.checkpoint() : undefined,
          ])
          const base = taskToBeadsIssue(todo, {
            sessionID,
            agent: state.agent,
            externalRef: externalRef(sessionID, todo.id),
          })
          base.dependencies = undefined
          base.parent = undefined
          return Beads.create({
            ...base,
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

  function applySpecGate(input: { todos: Info[]; existingByTodo: Map<string, BeadsIssue> }) {
    const pending = new Set(
      input.todos
        .filter((todo) => {
          const nextStatus = Task.normalizeStatus(todo.status)
          if (nextStatus !== "closed") return false
          if (Task.isSpecComplete(todo)) return false
          const existing = input.existingByTodo.get(todo.id)
          const prevStatus = existing ? Task.normalizeStatus(existing.status) : undefined
          if (prevStatus === "closed" || prevStatus === "draft") return false
          return true
        })
        .map((todo) => todo.id),
    )
    if (pending.size === 0) return input.todos
    return input.todos.map((todo) => {
      if (!pending.has(todo.id)) return todo
      const existing = input.existingByTodo.get(todo.id)
      const prevStatus = existing ? Task.normalizeStatus(existing.status) : undefined
      const fallback = prevStatus && !Task.isDoneStatus(prevStatus) ? prevStatus : "blocked"
      return {
        ...todo,
        status: fallback,
      }
    })
  }

  export async function update(input: {
    sessionID: string
    todos: Info[]
    agent?: string
    tool?: { messageID: string; callID?: string }
  }): Promise<Info[]> {
    const todos = input.todos
      .map(normalizeTodo)
      .map((todo) => applyAssignee(todo, input.agent))
      .map(applyTracker)
    const existing = await listSessionIssues(input.sessionID)
    const existingByTodo = new Map<string, BeadsIssue>()
    for (const issue of existing) {
      const todoID = TaskLabels.extractTodoID(issue.labels) ?? extractTodoIDFromExternalRef(issue.external_ref)
      if (todoID) existingByTodo.set(todoID, issue)
    }

    const labelSession = TaskLabels.session(input.sessionID)
    const specGatedTodos = applySpecGate({ todos, existingByTodo })
    const gatedTodos = await applyCheckpointGate({
      sessionID: input.sessionID,
      todos: specGatedTodos,
      existingByTodo,
      tool: input.tool,
    })
    const config = await Config.get().catch(() => undefined)
    const waveSize = config?.task?.session_wave_size ?? DEFAULT_SESSION_WAVE_SIZE
    const singleActive = applySingleActive(gatedTodos)
    const boundedTodos = applyWaveLimit(singleActive, waveSize)

    const seen = new Set<string>()
    const issueByTodo = new Map<string, BeadsIssue>()
    const checkpointClosing: Info[] = []

    for (const todo of boundedTodos) {
      const labelTodo = TaskLabels.todo(todo.id)
      const existingIssue = existingByTodo.get(todo.id)
      const existingTask = existingIssue ? beadsIssueToTask(existingIssue, { id: todo.id }) : undefined
      const currentVersion = existingTask?.version ?? 0
      const nextVersion = existingIssue ? (todo.version ?? currentVersion + 1) : todo.version ?? 0
      todo.version = nextVersion
      const ref = externalRef(input.sessionID, todo.id)
      const base = taskToBeadsIssue(todo, { sessionID: input.sessionID, agent: input.agent, externalRef: ref })
      base.dependencies = undefined
      base.parent = undefined
      const assigneeLabel = TaskLabels.agent(todo.assignee ?? input.agent)
      const labels = uniqueLabels([
        labelSession,
        labelTodo,
        assigneeLabel,
        todo.checkpoint ? TaskLabels.checkpoint() : undefined,
      ])
      const removeLabels =
        assigneeLabel && existingIssue?.labels
          ? existingIssue.labels.filter(
              (label) => label.startsWith(TaskLabels.prefixes.agent) && label !== assigneeLabel,
            )
          : undefined
      const removeCheckpoint =
        !todo.checkpoint && existingIssue?.labels?.includes(TaskLabels.prefixes.checkpoint)
          ? [TaskLabels.prefixes.checkpoint]
          : []
      const combinedRemove = uniqueLabels([...(removeLabels ?? []), ...removeCheckpoint])

      if (existingIssue) {
        const updated = await Beads.update({
          id: existingIssue.id,
          ...base,
          add_labels: labels,
          remove_labels: combinedRemove.length ? combinedRemove : undefined,
        })
        issueByTodo.set(todo.id, updated)
        const prevStatus = Task.normalizeStatus(existingIssue.status)
        const nextStatus = Task.normalizeStatus(todo.status)
        if (todo.checkpoint && prevStatus !== nextStatus && Task.isDoneStatus(nextStatus)) {
          checkpointClosing.push(todo)
        }
      } else {
        const created = await Beads.create({
          ...base,
          labels,
          ephemeral: true,
        })
        issueByTodo.set(todo.id, created)
        const nextStatus = Task.normalizeStatus(todo.status)
        if (todo.checkpoint && Task.isDoneStatus(nextStatus)) {
          checkpointClosing.push(todo)
        }
      }
      seen.add(todo.id)
    }

    const todoToIssue = new Map<string, string>()
    for (const [todoId, issue] of issueByTodo) {
      todoToIssue.set(todoId, issue.id)
    }
    for (const issue of existing) {
      const todoID = TaskLabels.extractTodoID(issue.labels) ?? extractTodoIDFromExternalRef(issue.external_ref)
      if (!todoID || todoToIssue.has(todoID)) continue
      todoToIssue.set(todoID, issue.id)
    }
    const issueIds = new Set<string>(todoToIssue.values())

    await Promise.all(
      boundedTodos.map(async (todo) => {
        const issue = issueByTodo.get(todo.id)
        if (!issue) return
        const desired = resolveDependencyIds(todo.dependsOn, { todoToIssue, issueIds })
        await syncDependencies(issue, desired)
      }),
    )

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

    const checkpointSnapshot =
      checkpointClosing.length > 0 ? await Snapshot.track().catch(() => undefined) : undefined
    await TaskHistory.record({
      tasks: boundedTodos,
      sessionID: input.sessionID,
      agent: input.agent,
      messageID: input.tool?.messageID,
      toolCallID: input.tool?.callID,
      checkpointSnapshot,
    }).catch(() => {})
    await TaskMetrics.updateMany(boundedTodos.map((todo) => todo.id)).catch(() => {})

    const now = Date.now()
    const blockingCount = boundedTodos.filter((todo) => Task.isBlockingStatus(todo.status)).length
    const active: ActiveTodo[] = boundedTodos
      .filter((todo) => Task.normalizeStatus(todo.status) === "in_progress")
      .map((todo) => ({
        id: todo.id,
        lane: todo.lane ?? "session",
        status: Task.normalizeStatus(todo.status),
        updatedAt: now,
      }))
    const prevState = await readState(input.sessionID).catch(() => undefined)
    const iteration = (prevState?.iteration ?? 0) + 1

    await writeState(input.sessionID, {
      sessionID: input.sessionID,
      agent: input.agent,
      updatedAt: now,
      todos: boundedTodos,
      iteration,
      active,
      completion: {
        done: blockingCount === 0,
        blocking: blockingCount,
        updatedAt: now,
      },
    }).catch(() => {})
    await updateSessionIndex({
      sessionID: input.sessionID,
      updatedAt: now,
      iteration,
      activeTodoIds: active.map((item) => item.id),
      completion: {
        done: blockingCount === 0,
        blocking: blockingCount,
        updatedAt: now,
      },
    }).catch(() => {})
    await appendProgress(input.sessionID, boundedTodos).catch(() => {})
    await TaskState.updateSession({
      sessionID: input.sessionID,
      agent: input.agent,
      todos: boundedTodos,
      checkpointSnapshot,
    }).catch(() => {})

    Bus.publish(Event.Updated, { sessionID: input.sessionID, todos: boundedTodos })
    return boundedTodos
  }

  export async function recordActive(input: { sessionID: string; todoId: string; lane?: Task.Lane; runId?: string }) {
    const now = Date.now()
    const existing = (await readState(input.sessionID).catch(() => undefined)) ?? {
      sessionID: input.sessionID,
      updatedAt: now,
      todos: [] as Info[],
    }
    const active = new Map(
      (existing.active ?? []).map((item) => [item.id, item]),
    )
    active.set(input.todoId, {
      id: input.todoId,
      lane: input.lane ?? "session",
      runId: input.runId,
      updatedAt: now,
    })
    const next: SessionTodoState = {
      ...existing,
      updatedAt: now,
      active: Array.from(active.values()),
    }
    await writeState(input.sessionID, next).catch(() => {})
    await updateSessionIndex({
      sessionID: input.sessionID,
      updatedAt: now,
      iteration: next.iteration,
      activeTodoIds: next.active?.map((item) => item.id) ?? [],
      completion: next.completion,
    }).catch(() => {})
  }

  export async function clearActive(input: { sessionID: string; todoId: string }) {
    const now = Date.now()
    const existing = await readState(input.sessionID).catch(() => undefined)
    if (!existing) return
    const active = new Map((existing.active ?? []).map((item) => [item.id, item]))
    active.delete(input.todoId)
    const next: SessionTodoState = {
      ...existing,
      updatedAt: now,
      active: Array.from(active.values()),
    }
    await writeState(input.sessionID, next).catch(() => {})
    await updateSessionIndex({
      sessionID: input.sessionID,
      updatedAt: now,
      iteration: next.iteration,
      activeTodoIds: next.active?.map((item) => item.id) ?? [],
      completion: next.completion,
    }).catch(() => {})
  }

  async function resolveRun(sessionID: string, runId?: string) {
    if (runId) {
      const run = await TaskRun.get(runId)
      if (!run) throw new Error(`TaskRun not found: ${runId}`)
      return run
    }
    const run = await TaskRun.getActiveBySession(sessionID)
    if (!run) throw new Error("No active TaskRun for this session")
    return run
  }

  async function assertCapability(run: TaskRun.Info) {
    if (!run.capabilityTokenId) {
      throw new Error(`TaskRun ${run.id} missing capability token`)
    }
    const token = await CapabilityToken.get(run.capabilityTokenId)
    if (!token) throw new Error(`Capability token not found: ${run.capabilityTokenId}`)
    await CapabilityToken.assertValid(token)
    if (token.runId !== run.id) {
      throw new Error(`Capability token ${token.id} does not belong to TaskRun ${run.id}`)
    }
    if (token.scope.rootTodoId !== run.scope.rootTodoId) {
      throw new Error(`Capability token ${token.id} scope mismatch`)
    }
    if (token.depthRemaining === undefined || token.depthRemaining !== run.counters.depthRemaining) {
      await TaskRun.syncCapabilityDepth(run.id).catch(() => {})
      const refreshedRun = await TaskRun.get(run.id)
      const refreshedToken = refreshedRun?.capabilityTokenId
        ? await CapabilityToken.get(refreshedRun.capabilityTokenId)
        : undefined
      if (refreshedToken) {
        await CapabilityToken.assertValid(refreshedToken)
        if (refreshedToken.depthRemaining === refreshedRun?.counters.depthRemaining) {
          return refreshedToken
        }
        if (refreshedToken.runId !== run.id) {
          throw new Error(`Capability token ${refreshedToken.id} does not belong to TaskRun ${run.id}`)
        }
      }
      throw new Error(`Capability token ${token.id} depth mismatch`)
    }
    return token
  }

  function assertScope(run: TaskRun.Info, todoId: string) {
    if (run.scope.rootTodoId === todoId) return
    if (run.scope.createdChildIds.includes(todoId)) return
    throw new Error(`Todo ${todoId} is outside TaskRun scope`)
  }

  function assertReadScope(run: TaskRun.Info, todoId: string, allowedReadIds: Set<string>) {
    if (run.scope.rootTodoId === todoId) return
    if (run.scope.createdChildIds.includes(todoId)) return
    if (allowedReadIds.has(todoId)) return
    throw new Error(`Todo ${todoId} is outside TaskRun read scope`)
  }

  function findParentId(issues: BeadsIssue[], todoId: string) {
    for (const issue of issues) {
      const id = TaskLabels.extractTodoID(issue.labels) ?? extractTodoIDFromExternalRef(issue.external_ref)
      if (id !== todoId) continue
      const task = beadsIssueToTask(issue, { id })
      return task.parentId
    }
    return undefined
  }

  function findTaskById(issues: BeadsIssue[], todoId: string) {
    const issue = issues.find((item) => {
      const id = TaskLabels.extractTodoID(item.labels) ?? extractTodoIDFromExternalRef(item.external_ref)
      return id === todoId
    })
    if (!issue) return
    return beadsIssueToTask(issue, { id: todoId })
  }

  function buildReadScope(token: CapabilityToken.Info, root: Info | undefined, parentId?: string) {
    const allowed = new Set<string>()
    if (token.scope.allowParentRead && parentId) allowed.add(parentId)
    if (token.scope.allowDepsRead && root) {
      normalizeDependencyIds(root.dependsOn).forEach((id) => allowed.add(id))
      normalizeDependencyIds(root.blocks).forEach((id) => allowed.add(id))
    }
    return allowed
  }

  async function getIssueByTodoId(sessionID: string, todoId: string) {
    const issues = await listSessionIssues(sessionID)
    for (const issue of issues) {
      const id = TaskLabels.extractTodoID(issue.labels) ?? extractTodoIDFromExternalRef(issue.external_ref)
      if (id === todoId) return issue
    }
    return undefined
  }

  export async function getOne(input: { sessionID: string; todoId: string; runId?: string }) {
    const run = await resolveRun(input.sessionID, input.runId)
    const issues = await listSessionIssues(input.sessionID)
    const token = await assertCapability(run)
    await TaskRun.consumeOps(run.id)
    const root = findTaskById(issues, run.scope.rootTodoId)
    const parentId = findParentId(issues, run.scope.rootTodoId)
    const allowed = buildReadScope(token, root, parentId)
    assertReadScope(run, input.todoId, allowed)
    const issue = issues.find((item) => {
      const id = TaskLabels.extractTodoID(item.labels) ?? extractTodoIDFromExternalRef(item.external_ref)
      return id === input.todoId
    })
    if (!issue) throw new Error(`Todo not found: ${input.todoId}`)
    const todo = taskToUI(beadsIssueToTask(issue, { id: input.todoId }))
    await TaskRun.recordObserved(run.id, input.todoId, {
      version: todo.version ?? 0,
      snapshot: {
        status: todo.status,
        blocks: todo.blocks,
        dependsOn: todo.dependsOn,
        action: todo.action,
        verify: todo.verify,
        done: todo.done,
      },
    }).catch(() => {})
    return todo
  }

  export async function getById(input: { sessionID: string; todoId: string }) {
    const issue = await getIssueByTodoId(input.sessionID, input.todoId)
    if (!issue) throw new Error(`Todo not found: ${input.todoId}`)
    return taskToUI(beadsIssueToTask(issue, { id: input.todoId }))
  }

  export async function updateOne(input: {
    sessionID: string
    todoId: string
    patch: Partial<TodoPatch>
    expectedVersion?: number
    expected?: Partial<TodoPatch>
    runId?: string
    internal?: boolean
  }) {
    const run = await resolveRun(input.sessionID, input.runId)
    const token = input.internal ? undefined : await assertCapability(run)
    if (!input.internal) {
      await TaskRun.consumeOps(run.id)
    }
    assertScope(run, input.todoId)
    if (token && !token.scope.allowChildren && input.todoId !== run.scope.rootTodoId) {
      throw new Error(`Capability token forbids child updates for ${input.todoId}`)
    }
    const issue = await getIssueByTodoId(input.sessionID, input.todoId)
    if (!issue) throw new Error(`Todo not found: ${input.todoId}`)
    const existing = beadsIssueToTask(issue, { id: input.todoId })
    const normalized = applyTracker(Task.normalize(existing))
    const currentVersion = normalized.version ?? 0

    if (input.expectedVersion === undefined) {
      throw new Error(`Todo ${input.todoId} update requires expectedVersion`)
    }

    const { allowed, disallowed } = filterScopedPatch(input.patch)
    if (disallowed.length > 0) {
      throw new Error(`Todo ${input.todoId} patch contains disallowed fields: ${disallowed.join(", ")}`)
    }
    if (Object.keys(allowed).length === 0) {
      throw new Error(`Todo ${input.todoId} patch has no allowed fields`)
    }

    if (normalized.checkpoint && input.patch.status && Task.isDoneStatus(input.patch.status)) {
      throw new Error(`Cannot close checkpoint todo ${input.todoId} via scoped update`)
    }

    let expected = input.expected
    if (!expected && run.observed?.[input.todoId]) {
      expected = run.observed?.[input.todoId]?.snapshot as Partial<TodoPatch>
    }
    if (!expected) {
      throw new Error(`Todo ${input.todoId} update requires expected field values`)
    }

    const versionMismatch = input.expectedVersion !== currentVersion
    if (versionMismatch && !expectedMatches(normalized, expected, allowed)) {
      throw new Error(`Todo ${input.todoId} version mismatch`)
    }

    const updated = applyPatch(normalized, allowed)
    const nextVersion = currentVersion + 1
    const nextTask: Info = Task.normalize({
      ...updated,
      version: nextVersion,
    })

    if (
      Task.normalizeStatus(nextTask.status) === "closed" &&
      !Task.isSpecComplete(nextTask) &&
      Task.normalizeStatus(normalized.status) !== "closed" &&
      Task.normalizeStatus(normalized.status) !== "draft"
    ) {
      const missing = Task.missingSpec(nextTask).join(", ")
      throw new Error(`Todo ${input.todoId} missing required spec fields: ${missing}`)
    }

    const ref = externalRef(input.sessionID, input.todoId)
    const base = taskToBeadsIssue(nextTask, { sessionID: input.sessionID, agent: run.agentType, externalRef: ref })
    base.dependencies = undefined
    base.parent = undefined
    const assigneeLabel = TaskLabels.agent(nextTask.assignee ?? run.agentType)
    const labels = uniqueLabels([
      TaskLabels.session(input.sessionID),
      TaskLabels.todo(input.todoId),
      assigneeLabel,
      nextTask.checkpoint ? TaskLabels.checkpoint() : undefined,
    ])
    const removeLabels =
      assigneeLabel && issue.labels ? issue.labels.filter((label) => label.startsWith(TaskLabels.prefixes.agent) && label !== assigneeLabel) : undefined
    const removeCheckpoint =
      !nextTask.checkpoint && issue.labels?.includes(TaskLabels.prefixes.checkpoint) ? [TaskLabels.prefixes.checkpoint] : []
    const combinedRemove = uniqueLabels([...(removeLabels ?? []), ...removeCheckpoint])

    const updatedIssue = await Beads.update({
      id: issue.id,
      ...base,
      add_labels: labels,
      remove_labels: combinedRemove.length ? combinedRemove : undefined,
    })

    const issues = await listSessionIssues(input.sessionID)
    const todoToIssue = new Map<string, string>()
    for (const item of issues) {
      const id = TaskLabels.extractTodoID(item.labels) ?? extractTodoIDFromExternalRef(item.external_ref)
      if (id) todoToIssue.set(id, item.id)
    }
    const issueIds = new Set<string>(todoToIssue.values())
    const desired = resolveDependencyIds(nextTask.dependsOn, { todoToIssue, issueIds })
    await syncDependencies(updatedIssue, desired)

    await TaskMutation.record({
      runId: run.id,
      todoId: input.todoId,
      before: normalized,
      after: nextTask,
    }).catch(() => {})
    await TaskRun.recordWrite(run.id, Object.keys(allowed)).catch(() => {})
    await TaskRun.recordObserved(run.id, input.todoId, {
      version: nextTask.version ?? nextVersion,
      snapshot: {
        status: nextTask.status,
        blocks: nextTask.blocks,
        dependsOn: nextTask.dependsOn,
        action: nextTask.action,
        verify: nextTask.verify,
        done: nextTask.done,
      },
    }).catch(() => {})
    await TaskHistory.record({
      tasks: [nextTask],
      sessionID: input.sessionID,
      agent: run.agentType,
    }).catch(() => {})
    await TaskMetrics.update(nextTask.id).catch(() => {})

    return taskToUI(beadsIssueToTask(updatedIssue, { id: input.todoId }))
  }

  export async function createChild(input: {
    sessionID: string
    parentId: string
    task: Info
    runId?: string
  }) {
    const run = await resolveRun(input.sessionID, input.runId)
    const token = await assertCapability(run)
    await TaskRun.consumeOps(run.id)
    if (!token.scope.allowChildren) {
      throw new Error(`Capability token forbids child creation for TaskRun ${run.id}`)
    }
    if (input.parentId !== run.scope.rootTodoId) {
      throw new Error(`Child todos must be created under parent ${run.scope.rootTodoId}`)
    }
    if (run.counters.depthRemaining <= 0) {
      throw new Error(`TaskRun ${run.id} depthRemaining exhausted`)
    }
    if (run.scope.createdChildIds.length >= run.budgets.maxChildren) {
      throw new Error(`TaskRun ${run.id} exceeded maxChildren (${run.budgets.maxChildren})`)
    }
    const child = applyTracker(
      Task.normalize({
        ...input.task,
        parentId: input.parentId,
        status: input.task.status ?? "draft",
        version: 0,
      }),
    )
    const labelSession = TaskLabels.session(input.sessionID)
    const labelTodo = TaskLabels.todo(child.id)
    const assigneeLabel = TaskLabels.agent(child.assignee ?? run.agentType)
    const labels = uniqueLabels([labelSession, labelTodo, assigneeLabel, TaskLabels.run(run.id)])
    const ref = externalRef(input.sessionID, child.id)
    const issue = await Beads.create({
      ...taskToBeadsIssue(child, { sessionID: input.sessionID, agent: run.agentType, externalRef: ref }),
      labels,
      ephemeral: true,
    })
    await TaskRun.addChild(run.id, child.id)
    await TaskRun.consumeDepth(run.id)
    await TaskRun.syncCapabilityDepth(run.id).catch(() => {})
    await TaskMutation.record({
      runId: run.id,
      todoId: child.id,
      before: null,
      after: child,
    }).catch(() => {})
    await TaskRun.recordObserved(run.id, child.id, {
      version: child.version ?? 0,
      snapshot: {
        status: child.status,
        blocks: child.blocks,
        dependsOn: child.dependsOn,
        action: child.action,
        verify: child.verify,
        done: child.done,
      },
    }).catch(() => {})
    return taskToUI(beadsIssueToTask(issue, { id: child.id }))
  }

  export async function listChildren(input: { sessionID: string; parentId: string; runId?: string; limit?: number }) {
    const run = await resolveRun(input.sessionID, input.runId)
    const token = await assertCapability(run)
    await TaskRun.consumeOps(run.id)
    if (!token.scope.allowChildren) {
      throw new Error(`Capability token forbids child listing for TaskRun ${run.id}`)
    }
    if (input.parentId !== run.scope.rootTodoId) {
      throw new Error(`Children can only be listed for parent ${run.scope.rootTodoId}`)
    }
    const limit = input.limit ?? run.budgets.maxChildren
    const issues = await Beads.list({
      labels: [TaskLabels.session(input.sessionID)],
      status: "all",
      limit: limit > 0 ? limit : 0,
      include_templates: false,
      parent_id: input.parentId,
      ephemeral: true,
    })
    const todos = issues.map((issue) => {
      const todoID = TaskLabels.extractTodoID(issue.labels) ?? extractTodoIDFromExternalRef(issue.external_ref)
      return taskToUI(beadsIssueToTask(issue, { id: todoID }))
    })
    await Promise.all(
      todos.map((todo) =>
        TaskRun.recordObserved(run.id, todo.id, {
          version: todo.version ?? 0,
          snapshot: {
            status: todo.status,
            blocks: todo.blocks,
            dependsOn: todo.dependsOn,
            action: todo.action,
            verify: todo.verify,
            done: todo.done,
          },
        }).catch(() => {}),
      ),
    )
    return todos
  }

  export async function graph(input: {
    sessionID: string
    rootId: string
    runId?: string
    depth?: number
    limit?: number
    include?: {
      parent?: boolean
      deps?: boolean
      children?: boolean
    }
  }): Promise<Task.Graph> {
    const run = input.runId ? await resolveRun(input.sessionID, input.runId) : undefined
    const token = run ? await assertCapability(run) : undefined
    if (run) {
      await TaskRun.consumeOps(run.id)
      if (input.rootId !== run.scope.rootTodoId) {
        throw new Error(`Graph root must be ${run.scope.rootTodoId}`)
      }
    }
    const depth = input.depth ?? 1
    const limit = input.limit ?? (run ? Math.max(run.budgets.maxChildren, 10) : 50)
    const include = {
      parent: input.include?.parent ?? true,
      deps: input.include?.deps ?? true,
      children: input.include?.children ?? true,
    }
    if (token) {
      if (!token.scope.allowParentRead) include.parent = false
      if (!token.scope.allowDepsRead) include.deps = false
      if (!token.scope.allowChildren) include.children = false
    }

    const issues = await listSessionIssues(input.sessionID)
    const tasks = issues.map((issue) => {
      const id = TaskLabels.extractTodoID(issue.labels) ?? extractTodoIDFromExternalRef(issue.external_ref)
      return id ? taskToUI(beadsIssueToTask(issue, { id })) : undefined
    })
    const byId = new Map(tasks.filter(Boolean).map((task) => [task!.id, task!]))
    const root = byId.get(input.rootId)
    if (!root) throw new Error(`Todo not found: ${input.rootId}`)

    const nodes: Task.Summary[] = []
    const edges: Task.GraphEdge[] = []
    const seen = new Set<string>()

    const addNode = (task: Info) => {
      if (seen.has(task.id) || nodes.length >= limit) return
      seen.add(task.id)
      nodes.push({
        id: task.id,
        content: task.content,
        status: task.status,
        version: task.version,
        parentId: task.parentId,
        lane: task.lane,
      })
    }

    addNode(root)

    if (include.parent && root.parentId) {
      const parent = byId.get(root.parentId)
      if (parent) {
        addNode(parent)
        edges.push({ from: root.id, to: parent.id, type: "parent" })
      }
    }

    if (include.deps) {
      for (const depId of normalizeDependencyIds(root.dependsOn)) {
        const dep = byId.get(depId)
        if (dep) {
          addNode(dep)
          edges.push({ from: root.id, to: dep.id, type: "dependsOn" })
        }
      }
      for (const blockId of normalizeDependencyIds(root.blocks)) {
        const blocked = byId.get(blockId)
        if (blocked) {
          addNode(blocked)
          edges.push({ from: root.id, to: blocked.id, type: "blocks" })
        }
      }
    }

    if (include.children && depth > 0) {
      let frontier = [root]
      for (let level = 0; level < depth; level++) {
        const nextFrontier: Info[] = []
        for (const node of frontier) {
          const children = tasks.filter((task): task is Info => !!task && task.parentId === node.id)
          for (const child of children) {
            if (nodes.length >= limit) break
            addNode(child)
            edges.push({ from: node.id, to: child.id, type: "child" })
            nextFrontier.push(child)
          }
        }
        frontier = nextFrontier
        if (frontier.length === 0 || nodes.length >= limit) break
      }
    }

    if (run) {
      await Promise.all(
        nodes.map((node) =>
          TaskRun.recordObserved(run.id, node.id, {
            version: node.version ?? 0,
            snapshot: {
              status: node.status,
              blocks: byId.get(node.id)?.blocks,
              dependsOn: byId.get(node.id)?.dependsOn,
              action: byId.get(node.id)?.action,
              verify: byId.get(node.id)?.verify,
              done: byId.get(node.id)?.done,
            },
          }).catch(() => {}),
        ),
      )
    }

    return {
      root: {
        id: root.id,
        content: root.content,
        status: root.status,
        version: root.version,
        parentId: root.parentId,
        lane: root.lane,
      },
      nodes,
      edges,
    }
  }

  export async function listChildrenByParent(input: { sessionID: string; parentId: string }) {
    const issues = await Beads.list({
      labels: [TaskLabels.session(input.sessionID)],
      status: "all",
      limit: 0,
      include_templates: false,
      parent_id: input.parentId,
      ephemeral: true,
    })
    return issues.map((issue) => {
      const todoID = TaskLabels.extractTodoID(issue.labels) ?? extractTodoIDFromExternalRef(issue.external_ref)
      return taskToUI(beadsIssueToTask(issue, { id: todoID }))
    })
  }

  export async function cleanupDraftChildren(input: { sessionID: string; runId: string; mode?: "close" | "archive" }) {
    const run = await TaskRun.get(input.runId)
    if (!run) return
    const issues = await Beads.list({
      labels: [TaskLabels.session(input.sessionID), TaskLabels.run(run.id)],
      status: "all",
      limit: 0,
      include_templates: false,
      ephemeral: true,
    })
    const nextStatus = input.mode === "archive" ? "deferred" : "closed"
    await Promise.all(
      issues.map(async (issue) => {
        const todoID = TaskLabels.extractTodoID(issue.labels) ?? extractTodoIDFromExternalRef(issue.external_ref)
        if (!todoID || !run.scope.createdChildIds.includes(todoID)) return
        const before = beadsIssueToTask(issue, { id: todoID })
        if (Task.normalizeStatus(before.status) === nextStatus) return
        const updated = await updateOne({
          sessionID: input.sessionID,
          todoId: todoID,
          patch: { status: nextStatus },
          expectedVersion: before.version ?? 0,
          expected: { status: before.status },
          runId: run.id,
          internal: true,
        }).catch(() => undefined)
        if (!updated) return
        await Beads.update({
          id: issue.id,
          add_labels: [TaskLabels.orphaned()],
        }).catch(() => {})
      }),
    )
  }

  export async function promoteDraftChildren(input: { sessionID: string; runId: string }) {
    const run = await TaskRun.get(input.runId)
    if (!run) return
    const issues = await Beads.list({
      labels: [TaskLabels.session(input.sessionID), TaskLabels.run(run.id)],
      status: "all",
      limit: 0,
      include_templates: false,
      ephemeral: true,
    })
    const draftIssues = issues.filter((issue) => Task.normalizeStatus(issue.status) === "draft")
    if (draftIssues.length === 0) return
    await Promise.all(
      draftIssues.map((issue) => {
        const todoID = TaskLabels.extractTodoID(issue.labels) ?? extractTodoIDFromExternalRef(issue.external_ref)
        if (!todoID || !run.scope.createdChildIds.includes(todoID)) return
        const before = beadsIssueToTask(issue, { id: todoID })
        return updateOne({
          sessionID: input.sessionID,
          todoId: todoID,
          patch: { status: "open" },
          expectedVersion: before.version ?? 0,
          expected: { status: before.status },
          runId: run.id,
          internal: true,
        }).catch(() => {})
      }),
    )
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

  export async function ready(sessionID: string) {
    const issues = await listSessionIssues(sessionID).then((result) => recoverStale(sessionID, result))
    const todos = issues
      .map((issue) => {
        const todoID = TaskLabels.extractTodoID(issue.labels) ?? extractTodoIDFromExternalRef(issue.external_ref)
        return taskToUI(beadsIssueToTask(issue, { id: todoID }))
      })
      .sort(sortTodos)
    const byId = new Map(todos.map((todo) => [todo.id, todo]))
    return todos.filter(
      (todo) => Task.normalizeStatus(todo.status) === "open" && !hasUnresolvedDeps(todo, byId),
    )
  }
}
