import fs from "fs/promises"
import path from "path"
import { Beads } from "@/beads/client"
import type { BeadsIssue } from "@/beads/protocol"
import { Config } from "@/config/config"
import { Global } from "@/global"
import { Instance } from "@/project/instance"
import { Question } from "@/question"
import { Snapshot } from "@/snapshot"
import { Task } from "@/task"
import { beadsIssueToTask, taskToBeadsIssue } from "@/task/adapters"
import { TaskHistory } from "@/task/history"
import { TaskLabels, agentLabelsToRemove, filterUserLabels, uniqueLabels } from "@/task/labels"
import { TaskState } from "@/task/state"
import { TaskRun } from "@/task/run"
import { TaskMutation } from "@/task/mutation"
import { TaskMetrics } from "@/task/metrics"
import { CapabilityToken } from "@/task/capability"
import { $ } from "bun"

export namespace RepoTodo {
  export const Info = Task.Info
  export type Info = Task.Info

  export type TodoPatch = Pick<
    Task.Info,
    "status" | "blocks" | "dependsOn" | "files" | "action" | "verify" | "done" | "issueType" | "tracker"
  >

  const SCOPED_PATCH_FIELDS: Array<keyof TodoPatch> = ["status", "blocks", "dependsOn", "action", "verify", "done"]

  type RepoStore = {
    updatedAt: string
    todos: Info[]
  }

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

  function clampText(value?: string, max = 200) {
    if (!value) return
    const trimmed = value.trim()
    if (trimmed.length <= max) return trimmed
    return trimmed.slice(0, Math.max(0, max - 1)).trimEnd() + "…"
  }

  function completionSummary(todo: Info) {
    return (
      clampText(todo.done) ??
      clampText(todo.verify) ??
      clampText(todo.action) ??
      clampText(todo.content)
    )
  }

  function buildCompletionComment(input: {
    todo: Info
    status: Task.Status
    sessionID?: string
    commit?: string
  }) {
    const lines = [
      "opencode:completion",
      `todo_id: ${input.todo.id}`,
      `status: ${input.status}`,
      input.sessionID ? `session: ${input.sessionID}` : undefined,
      `summary: ${completionSummary(input.todo)}`,
      input.commit ? `commit: ${input.commit}` : undefined,
      input.todo.checkpoint ? "checkpoint: true" : undefined,
    ].filter(Boolean)
    return lines.join("\n")
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
    const normalized = Task.normalize(todo)
    return normalized.lane === "repo" ? normalized : { ...normalized, lane: "repo" }
  }

  function applyAssignee(todo: Info, agent?: string) {
    if (!agent || todo.assignee) return todo
    return { ...todo, assignee: agent }
  }

  async function trackerInfo() {
    const mode = await trackerMode()
    if (mode === "json") {
      const path = await jsonPath()
      return { id: "json", mode: "repo" as const, path }
    }
    return { id: "beads", mode: "repo" as const }
  }

  function applyTracker(todo: Info, tracker?: Task.Tracker): Info {
    if (todo.tracker?.id || !tracker) return todo
    return Task.normalize({ ...todo, tracker })
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
    const setAllowed = <K extends keyof TodoPatch>(field: K, value: TodoPatch[K]) => {
      allowed[field] = value
    }
    for (const field of SCOPED_PATCH_FIELDS) {
      const value = patch[field]
      if (value !== undefined) setAllowed(field, value as TodoPatch[typeof field])
    }
    const disallowed = Object.keys(patch).filter((field) => !(SCOPED_PATCH_FIELDS as string[]).includes(field))
    return { allowed, disallowed }
  }

  function applySpecGate(input: {
    todos: Info[]
    getPrevStatus: (todoId: string) => Task.Status | undefined
  }): Info[] {
    const pending = new Set(
      input.todos
        .filter((todo) => {
          const nextStatus = Task.normalizeStatus(todo.status)
          if (nextStatus !== "closed") return false
          if (Task.isSpecComplete(todo)) return false
          const prevRaw = input.getPrevStatus(todo.id)
          const prevStatus = prevRaw ? Task.normalizeStatus(prevRaw) : undefined
          if (prevStatus === "closed" || prevStatus === "draft") return false
          return true
        })
        .map((todo) => todo.id),
    )
    if (pending.size === 0) return input.todos
    return input.todos.map((todo) => {
      if (!pending.has(todo.id)) return todo
      const prevRaw = input.getPrevStatus(todo.id)
      const prevStatus = prevRaw ? Task.normalizeStatus(prevRaw) : undefined
      const fallback = prevStatus && !Task.isDoneStatus(prevStatus) ? prevStatus : "blocked"
      return Task.normalize({
        ...todo,
        status: fallback,
      })
    })
  }

  async function applyCheckpointGate(input: {
    sessionID?: string
    todos: Info[]
    getPrevStatus: (todoId: string) => Task.Status | undefined
    tool?: { messageID: string; callID?: string }
  }): Promise<Info[]> {
    const pending = input.todos.filter((todo) => {
      if (!todo.checkpoint) return false
      if (Task.normalizeStatus(todo.status) !== "closed") return false
      const prev = input.getPrevStatus(todo.id)
      return Task.normalizeStatus(prev ?? "open") !== "closed"
    })

    if (pending.length === 0) return input.todos
    if (!input.sessionID) {
      return input.todos.map((todo) => {
        if (!pending.find((item) => item.id === todo.id)) return todo
        const prev = input.getPrevStatus(todo.id)
        const fallback = prev && !Task.isDoneStatus(prev) ? prev : "blocked"
        return Task.normalize({
          ...todo,
          status: fallback,
        })
      })
    }

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
      const prev = input.getPrevStatus(todo.id)
      const fallback = prev && !Task.isDoneStatus(prev) ? prev : "blocked"
      return Task.normalize({
        ...todo,
        status: fallback,
      })
    })
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

  async function trackerMode() {
    const cfg = await Config.get()
    return cfg.task?.repo_tracker ?? "beads"
  }

  async function jsonPath() {
    const cfg = await Config.get()
    const custom = cfg.task?.repo_tracker_path
    const base = Instance.project.vcs ? Instance.worktree : Global.Path.data
    if (custom) return path.isAbsolute(custom) ? custom : path.join(base, custom)
    const defaultBase = Instance.project.vcs ? path.join(Instance.worktree, ".opencode") : Global.Path.data
    return path.join(defaultBase, "tasks.json")
  }

  async function readRepoStore(): Promise<RepoStore> {
    const file = await jsonPath()
    const data = await Bun.file(file)
      .json()
      .catch(() => undefined)
    if (!data) {
      return { updatedAt: new Date(0).toISOString(), todos: [] }
    }
    if (Array.isArray(data)) {
      return { updatedAt: new Date(0).toISOString(), todos: data as Info[] }
    }
    if (typeof data === "object" && data !== null) {
      const obj = data as { updatedAt?: string; todos?: Info[] }
      return {
        updatedAt: typeof obj.updatedAt === "string" ? obj.updatedAt : new Date(0).toISOString(),
        todos: Array.isArray(obj.todos) ? obj.todos : [],
      }
    }
    return { updatedAt: new Date(0).toISOString(), todos: [] }
  }

  async function writeRepoStore(todos: Info[]) {
    const file = await jsonPath()
    await fs.mkdir(path.dirname(file), { recursive: true })
    const payload: RepoStore = {
      updatedAt: new Date().toISOString(),
      todos,
    }
    await fs.writeFile(file, JSON.stringify(payload, null, 2))
  }

  async function listBeads(input?: { agent?: string; status?: string; limit?: number }) {
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

  async function readyBeads(input?: { agent?: string; limit?: number }) {
    const labels = uniqueLabels([repoLabel(), agentLabel(input?.agent)])
    const issues = await Beads.ready({
      labels,
      limit: input?.limit ?? 10,
    })
    const todos = issues
      .map((issue) => {
        const todoID = todoIDFromIssue(issue)
        return beadsIssueToTask(issue, { id: todoID })
      })
      .sort(sortTodos)
    const filtered = todos.filter(
      (todo) => Task.normalizeStatus(todo.status) !== "draft" && Task.isSpecComplete(todo),
    )
    const needsDependencyData = filtered.some(
      (todo) => (todo.dependsOn && todo.dependsOn.length > 0) || (todo.blocks && todo.blocks.length > 0),
    )
    if (!needsDependencyData) return filtered
    const allTodos = await listBeads({ status: "all", agent: input?.agent })
    const byId = new Map(allTodos.map((todo) => [todo.id, todo]))
    const enriched = filtered.map((todo) => byId.get(todo.id) ?? todo)
    return enriched.filter((todo) => !hasUnresolvedDeps(todo, byId))
  }

  async function upsertBeads(input: {
    sessionID?: string
    agent?: string
    todos: Info[]
    tool?: { messageID: string; callID?: string }
  }) {
    const tracker = { id: "beads", mode: "repo" as const }
    const todos = input.todos
      .map(normalizeTodo)
      .map((todo) => applyAssignee(todo, input.agent))
      .map((todo) => applyTracker(todo, tracker))
    const labelsBase = uniqueLabels([repoLabel()])
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

    const specGatedTodos = applySpecGate({
      todos,
      getPrevStatus: (todoId) => {
        const existingIssue = existingByTodo.get(todoId)
        return existingIssue ? Task.normalizeStatus(existingIssue.status) : undefined
      },
    })
    const gatedTodos = await applyCheckpointGate({
      sessionID: input.sessionID,
      todos: specGatedTodos,
      getPrevStatus: (todoId) => {
        const existingIssue = existingByTodo.get(todoId)
        return existingIssue ? Task.normalizeStatus(existingIssue.status) : undefined
      },
      tool: input.tool,
    })
    const commit = await currentCommit().catch(() => undefined)

    const issueByTodo = new Map<string, BeadsIssue>()
    const checkpointClosing: Info[] = []

    for (const todo of gatedTodos) {
      const labelTodo = TaskLabels.todo(todo.id)
      const existingIssue = existingByTodo.get(todo.id)
      const existingTask = existingIssue ? beadsIssueToTask(existingIssue, { id: todo.id }) : undefined
      const currentVersion = existingTask?.version ?? 0
      const nextVersion = existingIssue ? currentVersion + 1 : 0
      todo.version = nextVersion
      const ref = TaskLabels.repoExternalRef(Instance.project.id, todo.id)
      const base = taskToBeadsIssue(todo, { agent: input.agent, externalRef: ref })
      base.dependencies = undefined
      base.parent = undefined
      const assigneeLabel = TaskLabels.agent(todo.assignee ?? input.agent)
      const userLabels = filterUserLabels(todo.labels)
      const labels = uniqueLabels([
        repoLabel(),
        labelTodo,
        assigneeLabel,
        todo.checkpoint ? TaskLabels.checkpoint() : undefined,
        ...(userLabels ?? []),
      ])
      const removeLabels = agentLabelsToRemove(existingIssue?.labels, assigneeLabel)
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
        if (prevStatus !== nextStatus && Task.isDoneStatus(nextStatus)) {
          const author = input.agent ?? "opencode"
          const text = buildCompletionComment({
            todo,
            status: nextStatus,
            sessionID: input.sessionID,
            commit,
          })
          await Beads.comments.add({ id: existingIssue.id, author, text }).catch(() => {})
        }
        if (todo.checkpoint && prevStatus !== nextStatus && Task.isDoneStatus(nextStatus)) {
          checkpointClosing.push(todo)
        }
      } else {
        const created = await Beads.create({
          ...base,
          labels,
          ephemeral: false,
        })
        issueByTodo.set(todo.id, created)
        const nextStatus = Task.normalizeStatus(todo.status)
        if (Task.isDoneStatus(nextStatus)) {
          const author = input.agent ?? "opencode"
          const text = buildCompletionComment({
            todo,
            status: nextStatus,
            sessionID: input.sessionID,
            commit,
          })
          await Beads.comments.add({ id: created.id, author, text }).catch(() => {})
        }
        if (todo.checkpoint && Task.isDoneStatus(nextStatus)) {
          checkpointClosing.push(todo)
        }
      }
    }

    const todoToIssue = new Map<string, string>()
    for (const [todoId, issue] of issueByTodo) {
      todoToIssue.set(todoId, issue.id)
    }
    for (const issue of existing) {
      const todoID = todoIDFromIssue(issue)
      if (!todoID || todoToIssue.has(todoID)) continue
      todoToIssue.set(todoID, issue.id)
    }
    const issueIds = new Set<string>(todoToIssue.values())

    await Promise.all(
      gatedTodos.map(async (todo) => {
        const issue = issueByTodo.get(todo.id)
        if (!issue) return
        const desired = resolveDependencyIds(todo.dependsOn, { todoToIssue, issueIds })
        await syncDependencies(issue, desired)
      }),
    )

    const checkpointSnapshot =
      checkpointClosing.length > 0 ? await Snapshot.track().catch(() => undefined) : undefined
    await TaskHistory.record({
      tasks: gatedTodos,
      sessionID: input.sessionID,
      agent: input.agent,
      messageID: input.tool?.messageID,
      toolCallID: input.tool?.callID,
      checkpointSnapshot,
    }).catch(() => {})
    await TaskMetrics.updateMany(gatedTodos.map((todo) => todo.id)).catch(() => {})

    const existingTodos = existing
      .map((issue) => {
        const todoID = todoIDFromIssue(issue)
        return beadsIssueToTask(issue, { id: todoID })
      })
      .map(normalizeTodo)
    const allById = new Map<string, Info>(existingTodos.map((todo) => [todo.id, todo]))
    for (const todo of gatedTodos) allById.set(todo.id, todo)
    const allTodos = Array.from(allById.values()).sort(sortTodos)
    const stateTodos = input.agent
      ? allTodos.filter((todo) => (todo.assignee ?? input.agent) === input.agent)
      : allTodos
    await TaskState.updateRepo({
      agent: input.agent,
      todos: stateTodos,
      checkpointSnapshot,
    }).catch(() => {})
    return gatedTodos
  }

  async function resolveRun(sessionID: string | undefined, runId?: string) {
    if (!sessionID) throw new Error("sessionID required for scoped repo operations")
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

  function buildReadScope(token: CapabilityToken.Info, root?: Info, parentId?: string) {
    const allowed = new Set<string>()
    if (token.scope.allowParentRead && parentId) allowed.add(parentId)
    if (token.scope.allowDepsRead && root) {
      normalizeDependencyIds(root.dependsOn).forEach((id) => allowed.add(id))
      normalizeDependencyIds(root.blocks).forEach((id) => allowed.add(id))
    }
    return allowed
  }

  async function getIssueByTodoId(todoId: string, agent?: string) {
    const labels = uniqueLabels([repoLabel(), agentLabel(agent)])
    const issues = await Beads.list({
      labels,
      status: "all",
      limit: 0,
      include_templates: false,
      ephemeral: false,
    })
    return issues.find((issue) => todoIDFromIssue(issue) === todoId || issue.id === todoId)
  }

  export async function getOne(input: { sessionID: string; todoId: string; agent?: string; runId?: string }) {
    const run = await resolveRun(input.sessionID, input.runId)
    const token = await assertCapability(run)
    await TaskRun.consumeOps(run.id)
    const mode = await trackerMode()
    if (mode === "json") {
      const tracker = { id: "json", mode: "repo" as const, path: await jsonPath() }
      const store = await readRepoStore()
      const root = store.todos.find((item) => item.id === run.scope.rootTodoId)
      const parentId = root?.parentId
      const allowed = buildReadScope(token, root ? applyTracker(Task.normalize(root), tracker) : undefined, parentId)
      assertReadScope(run, input.todoId, allowed)
      const todo = store.todos.find((item) => item.id === input.todoId)
      if (!todo) throw new Error(`Todo not found: ${input.todoId}`)
      const normalized = applyTracker(Task.normalize(todo), tracker)
      await TaskRun.recordObserved(run.id, input.todoId, {
        version: normalized.version ?? 0,
        snapshot: {
          status: normalized.status,
          blocks: normalized.blocks,
          dependsOn: normalized.dependsOn,
          action: normalized.action,
          verify: normalized.verify,
          done: normalized.done,
        },
      }).catch(() => {})
      return normalized
    }
    const parentIssue = await getIssueByTodoId(run.scope.rootTodoId, input.agent)
    const parentId = parentIssue ? beadsIssueToTask(parentIssue, { id: run.scope.rootTodoId }).parentId : undefined
    const rootIssue = parentIssue ?? (await getIssueByTodoId(run.scope.rootTodoId, input.agent))
    const root = rootIssue ? beadsIssueToTask(rootIssue, { id: run.scope.rootTodoId }) : undefined
    const allowed = buildReadScope(token, root, parentId)
    assertReadScope(run, input.todoId, allowed)
    const issue = await getIssueByTodoId(input.todoId, input.agent)
    if (!issue) throw new Error(`Todo not found: ${input.todoId}`)
    const todo = beadsIssueToTask(issue, { id: input.todoId })
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

  export async function getById(input: { todoId: string; agent?: string }) {
    const mode = await trackerMode()
    if (mode === "json") {
      const tracker = { id: "json", mode: "repo" as const, path: await jsonPath() }
      const store = await readRepoStore()
      const todo = store.todos.find((item) => item.id === input.todoId)
      if (!todo) throw new Error(`Todo not found: ${input.todoId}`)
      return applyTracker(Task.normalize(todo), tracker)
    }
    const issue = await getIssueByTodoId(input.todoId, input.agent)
    if (!issue) throw new Error(`Todo not found: ${input.todoId}`)
    return beadsIssueToTask(issue, { id: input.todoId })
  }

  export async function updateOne(input: {
    sessionID: string
    todoId: string
    agent?: string
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
    const mode = await trackerMode()
    const tracker =
      mode === "json"
        ? { id: "json", mode: "repo" as const, path: await jsonPath() }
        : { id: "beads", mode: "repo" as const }
    if (mode === "json") {
      const store = await readRepoStore()
      const existing = store.todos.find((todo) => todo.id === input.todoId)
      if (!existing) throw new Error(`Todo not found: ${input.todoId}`)
      const normalized = applyTracker(Task.normalize(existing), tracker)
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
      const next = applyTracker(Task.normalize({ ...updated, version: currentVersion + 1 }), tracker)
      if (
        Task.normalizeStatus(next.status) === "closed" &&
        !Task.isSpecComplete(next) &&
        Task.normalizeStatus(normalized.status) !== "closed" &&
        Task.normalizeStatus(normalized.status) !== "draft"
      ) {
        const missing = Task.missingSpec(next).join(", ")
        throw new Error(`Todo ${input.todoId} missing required spec fields: ${missing}`)
      }
      store.todos = store.todos.map((todo) => (todo.id === input.todoId ? next : todo))
      await writeRepoStore(store.todos)
      await TaskMutation.record({
        runId: run.id,
        todoId: input.todoId,
        before: normalized,
        after: next,
      }).catch(() => {})
      await TaskRun.recordWrite(run.id, Object.keys(allowed)).catch(() => {})
      await TaskRun.recordObserved(run.id, input.todoId, {
        version: next.version ?? currentVersion + 1,
        snapshot: {
          status: next.status,
          blocks: next.blocks,
          dependsOn: next.dependsOn,
          action: next.action,
          verify: next.verify,
          done: next.done,
        },
      }).catch(() => {})
      await TaskHistory.record({
        tasks: [next],
        sessionID: input.sessionID,
        agent: run.agentType,
      }).catch(() => {})
      await TaskMetrics.update(next.id).catch(() => {})
      return next
    }

    const issue = await getIssueByTodoId(input.todoId, input.agent)
    if (!issue) throw new Error(`Todo not found: ${input.todoId}`)
    const existing = beadsIssueToTask(issue, { id: input.todoId })
    const normalized = applyTracker(Task.normalize(existing), tracker)
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
    const next = applyTracker(Task.normalize({ ...updated, version: currentVersion + 1 }), tracker)
    if (
      Task.normalizeStatus(next.status) === "closed" &&
      !Task.isSpecComplete(next) &&
      Task.normalizeStatus(normalized.status) !== "closed" &&
      Task.normalizeStatus(normalized.status) !== "draft"
    ) {
      const missing = Task.missingSpec(next).join(", ")
      throw new Error(`Todo ${input.todoId} missing required spec fields: ${missing}`)
    }
    const ref = TaskLabels.repoExternalRef(Instance.project.id, input.todoId)
    const base = taskToBeadsIssue(next, { agent: run.agentType, externalRef: ref })
    base.dependencies = undefined
    base.parent = undefined
    const assigneeLabel = TaskLabels.agent(next.assignee ?? run.agentType)
    const userLabels = filterUserLabels(next.labels)
    const labels = uniqueLabels([repoLabel(), TaskLabels.todo(input.todoId), assigneeLabel, ...(userLabels ?? [])])
    const removeLabels = agentLabelsToRemove(issue.labels, assigneeLabel)
    const removeCheckpoint =
      !next.checkpoint && issue.labels?.includes(TaskLabels.prefixes.checkpoint) ? [TaskLabels.prefixes.checkpoint] : []
    const combinedRemove = uniqueLabels([...(removeLabels ?? []), ...removeCheckpoint])

    const updatedIssue = await Beads.update({
      id: issue.id,
      ...base,
      add_labels: labels,
      remove_labels: combinedRemove.length ? combinedRemove : undefined,
    })
    const labelsBase = uniqueLabels([repoLabel()])
    const issues = await Beads.list({
      labels: labelsBase,
      status: "all",
      limit: 0,
      include_templates: false,
      ephemeral: false,
    })
    const todoToIssue = new Map<string, string>()
    for (const item of issues) {
      const id = todoIDFromIssue(item)
      if (id) todoToIssue.set(id, item.id)
    }
    const issueIds = new Set<string>(todoToIssue.values())
    const desired = resolveDependencyIds(next.dependsOn, { todoToIssue, issueIds })
    await syncDependencies(updatedIssue, desired)

    const prevStatus = Task.normalizeStatus(normalized.status)
    const nextStatus = Task.normalizeStatus(next.status)
    if (prevStatus !== nextStatus && Task.isDoneStatus(nextStatus)) {
      const author = run.agentType ?? "opencode"
      const commit = await currentCommit().catch(() => undefined)
      const text = buildCompletionComment({
        todo: next,
        status: nextStatus,
        sessionID: input.sessionID,
        commit,
      })
      await Beads.comments.add({ id: updatedIssue.id, author, text }).catch(() => {})
    }

    await TaskMutation.record({
      runId: run.id,
      todoId: input.todoId,
      before: normalized,
      after: next,
    }).catch(() => {})
    await TaskRun.recordWrite(run.id, Object.keys(allowed)).catch(() => {})
    await TaskRun.recordObserved(run.id, input.todoId, {
      version: next.version ?? currentVersion + 1,
      snapshot: {
        status: next.status,
        blocks: next.blocks,
        dependsOn: next.dependsOn,
        action: next.action,
        verify: next.verify,
        done: next.done,
      },
    }).catch(() => {})
    await TaskHistory.record({
      tasks: [next],
      sessionID: input.sessionID,
      agent: run.agentType,
    }).catch(() => {})
    await TaskMetrics.update(next.id).catch(() => {})
    return beadsIssueToTask(updatedIssue, { id: input.todoId })
  }

  export async function createChild(input: {
    sessionID: string
    parentId: string
    task: Info
    agent?: string
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
    const child = Task.normalize({
      ...input.task,
      parentId: input.parentId,
      lane: "repo",
      status: input.task.status ?? "draft",
      version: 0,
    })
    const mode = await trackerMode()
    if (mode === "json") {
      const tracker = { id: "json", mode: "repo" as const, path: await jsonPath() }
      const storedChild = applyTracker(child, tracker)
      const store = await readRepoStore()
      store.todos = [...store.todos, storedChild]
      await writeRepoStore(store.todos)
      await TaskRun.addChild(run.id, child.id)
      await TaskRun.consumeDepth(run.id)
      await TaskMutation.record({
        runId: run.id,
        todoId: child.id,
        before: null,
        after: storedChild,
      }).catch(() => {})
      await TaskRun.recordObserved(run.id, child.id, {
        version: storedChild.version ?? 0,
        snapshot: {
          status: storedChild.status,
          blocks: storedChild.blocks,
          dependsOn: storedChild.dependsOn,
          action: storedChild.action,
          verify: storedChild.verify,
          done: storedChild.done,
        },
      }).catch(() => {})
      return storedChild
    }

    const trackedChild = applyTracker(child, { id: "beads", mode: "repo" })
    const ref = TaskLabels.repoExternalRef(Instance.project.id, child.id)
    const labels = uniqueLabels([
      repoLabel(),
      TaskLabels.todo(child.id),
      TaskLabels.agent(child.assignee ?? run.agentType),
      TaskLabels.run(run.id),
    ])
    const issue = await Beads.create({
      ...taskToBeadsIssue(trackedChild, { agent: run.agentType, externalRef: ref }),
      labels,
      ephemeral: false,
    })
    await TaskRun.addChild(run.id, child.id)
    await TaskRun.consumeDepth(run.id)
    await TaskRun.syncCapabilityDepth(run.id).catch(() => {})
    await TaskMutation.record({
      runId: run.id,
      todoId: child.id,
      before: null,
      after: trackedChild,
    }).catch(() => {})
    await TaskRun.recordObserved(run.id, child.id, {
      version: trackedChild.version ?? 0,
      snapshot: {
        status: trackedChild.status,
        blocks: trackedChild.blocks,
        dependsOn: trackedChild.dependsOn,
        action: trackedChild.action,
        verify: trackedChild.verify,
        done: trackedChild.done,
      },
    }).catch(() => {})
    return beadsIssueToTask(issue, { id: child.id })
  }

  export async function listChildren(input: { sessionID: string; parentId: string; agent?: string; runId?: string; limit?: number }) {
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
    const mode = await trackerMode()
    if (mode === "json") {
      const tracker = { id: "json", mode: "repo" as const, path: await jsonPath() }
      const store = await readRepoStore()
      const filtered = store.todos
        .filter((todo) => todo.parentId === input.parentId)
        .map((todo) => applyTracker(Task.normalize(todo), tracker))
      const todos = limit > 0 ? filtered.slice(0, limit) : filtered
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
    const issues = await Beads.list({
      labels: uniqueLabels([repoLabel(), TaskLabels.agent(input.agent)]),
      status: "all",
      limit: limit > 0 ? limit : 0,
      include_templates: false,
      parent_id: input.parentId,
      ephemeral: false,
    })
    const todos = issues.map((issue) => {
      const todoID = todoIDFromIssue(issue)
      return beadsIssueToTask(issue, { id: todoID })
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
    sessionID?: string
    rootId: string
    agent?: string
    runId?: string
    depth?: number
    limit?: number
    include?: {
      parent?: boolean
      deps?: boolean
      children?: boolean
    }
  }): Promise<Task.Graph> {
    if (input.runId && !input.sessionID) {
      throw new Error("sessionID required for scoped repo graph")
    }
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

    const mode = await trackerMode()
    let tasks: Info[] = []
    if (mode === "json") {
      const tracker = { id: "json", mode: "repo" as const, path: await jsonPath() }
      const store = await readRepoStore()
      tasks = store.todos.map((todo) => applyTracker(Task.normalize(todo), tracker))
    } else {
      const issues = await Beads.list({
        labels: uniqueLabels([repoLabel(), TaskLabels.agent(input.agent)]),
        status: "all",
        limit: 0,
        include_templates: false,
        ephemeral: false,
      })
      tasks = issues.map((issue) => {
        const todoID = todoIDFromIssue(issue)
        return beadsIssueToTask(issue, { id: todoID })
      })
    }

    const byId = new Map(tasks.map((task) => [task.id, task]))
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
          const children = tasks.filter((task) => task.parentId === node.id)
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

  export async function listChildrenByParent(input: { parentId: string; agent?: string }) {
    const mode = await trackerMode()
    if (mode === "json") {
      const tracker = { id: "json", mode: "repo" as const, path: await jsonPath() }
      const store = await readRepoStore()
      return store.todos
        .filter((todo) => todo.parentId === input.parentId)
        .map((todo) => applyTracker(Task.normalize(todo), tracker))
    }
    const issues = await Beads.list({
      labels: uniqueLabels([repoLabel(), TaskLabels.agent(input.agent)]),
      status: "all",
      limit: 0,
      include_templates: false,
      parent_id: input.parentId,
      ephemeral: false,
    })
    return issues.map((issue) => {
      const todoID = todoIDFromIssue(issue)
      return beadsIssueToTask(issue, { id: todoID })
    })
  }

  export async function cleanupDraftChildren(input: {
    sessionID: string
    runId: string
    mode?: "close" | "archive"
    agent?: string
  }) {
    const run = await TaskRun.get(input.runId)
    if (!run) return
    const mode = await trackerMode()
    if (mode === "json") {
      const store = await readRepoStore()
      const removed = store.todos.filter((todo) => run.scope.createdChildIds.includes(todo.id))
      store.todos = store.todos.filter((todo) => !run.scope.createdChildIds.includes(todo.id))
      await writeRepoStore(store.todos)
      await Promise.all(
        removed.map((todo) =>
          TaskMutation.record({
            runId: run.id,
            todoId: todo.id,
            before: todo,
            after: null,
          }).catch(() => {}),
        ),
      )
      return
    }
    const issues = await Beads.list({
      labels: uniqueLabels([repoLabel(), TaskLabels.run(run.id)]),
      status: "all",
      limit: 0,
      include_templates: false,
      ephemeral: false,
    })
    const nextStatus = input.mode === "archive" ? "deferred" : "closed"
    await Promise.all(
      issues.map(async (issue) => {
        const todoID = todoIDFromIssue(issue)
        if (!todoID || !run.scope.createdChildIds.includes(todoID)) return
        const before = beadsIssueToTask(issue, { id: todoID })
        if (Task.normalizeStatus(before.status) === nextStatus) return
        const updated = await updateOne({
          sessionID: input.sessionID,
          todoId: todoID,
          agent: input.agent,
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

  export async function promoteDraftChildren(input: { sessionID: string; runId: string; agent?: string }) {
    const run = await TaskRun.get(input.runId)
    if (!run) return
    const mode = await trackerMode()
    if (mode === "json") {
      const store = await readRepoStore()
      const changes: Array<{ before: Info; after: Info }> = []
      const promoted = store.todos.map((todo) => {
        if (!run.scope.createdChildIds.includes(todo.id)) return todo
        if (Task.normalizeStatus(todo.status) !== "draft") return todo
        const currentVersion = todo.version ?? 0
        const after = Task.normalize({ ...todo, status: "open", version: currentVersion + 1 })
        changes.push({ before: Task.normalize(todo), after })
        return after
      })
      store.todos = promoted
      await writeRepoStore(store.todos)
      await Promise.all(
        changes.map((change) =>
          TaskMutation.record({
            runId: run.id,
            todoId: change.after.id,
            before: change.before,
            after: change.after,
          }).catch(() => {}),
        ),
      )
      return
    }
    const issues = await Beads.list({
      labels: uniqueLabels([repoLabel(), TaskLabels.run(run.id)]),
      status: "all",
      limit: 0,
      include_templates: false,
      ephemeral: false,
    })
    const draftIssues = issues.filter((issue) => Task.normalizeStatus(issue.status) === "draft")
    if (draftIssues.length === 0) return
    await Promise.all(
      draftIssues.map((issue) => {
        const todoID = todoIDFromIssue(issue)
        if (!todoID || !run.scope.createdChildIds.includes(todoID)) return
        const before = beadsIssueToTask(issue, { id: todoID })
        return updateOne({
          sessionID: input.sessionID,
          todoId: todoID,
          agent: input.agent,
          patch: { status: "open" },
          expectedVersion: before.version ?? 0,
          expected: { status: before.status },
          runId: run.id,
          internal: true,
        }).catch(() => {})
      }),
    )
  }

  async function listJson(input?: { agent?: string; status?: string; limit?: number }) {
    const tracker = await trackerInfo()
    const { todos } = await readRepoStore()
    const normalized = todos.map(normalizeTodo).map((todo) => applyTracker(todo, tracker))
    const filtered = input?.agent
      ? normalized.filter((todo) => (todo.assignee ?? input.agent) === input.agent)
      : normalized
    const status = input?.status ? input.status.trim().toLowerCase() : undefined
    const byStatus =
      status && status !== "all"
        ? filtered.filter((todo) => Task.normalizeStatus(todo.status) === Task.normalizeStatus(status))
        : filtered
    const sorted = byStatus.sort(sortTodos)
    if (input?.limit && input.limit > 0) return sorted.slice(0, input.limit)
    return sorted
  }

  function hasUnresolvedDeps(todo: Info, byId: Map<string, Info>) {
    if (!todo.dependsOn || todo.dependsOn.length === 0) return false
    return todo.dependsOn.some((id) => {
      const dep = byId.get(id)
      if (!dep) return true
      return !Task.isDoneStatus(dep.status)
    })
  }

  async function readyJson(input?: { agent?: string; limit?: number }) {
    const tracker = await trackerInfo()
    const { todos } = await readRepoStore()
    const normalized = todos.map(normalizeTodo).map((todo) => applyTracker(todo, tracker))
    const byId = new Map(normalized.map((todo) => [todo.id, todo]))
    const filtered = input?.agent
      ? normalized.filter((todo) => (todo.assignee ?? input.agent) === input.agent)
      : normalized
    const ready = filtered.filter(
      (todo) =>
        Task.normalizeStatus(todo.status) === "open" &&
        !hasUnresolvedDeps(todo, byId) &&
        Task.isSpecComplete(todo),
    )
    const sorted = ready.sort(sortTodos)
    const limited = input?.limit && input.limit > 0 ? sorted.slice(0, input.limit) : sorted
    return limited
  }

  async function upsertJson(input: {
    sessionID?: string
    agent?: string
    todos: Info[]
    tool?: { messageID: string; callID?: string }
  }) {
    const tracker = await trackerInfo()
    const todos = input.todos
      .map(normalizeTodo)
      .map((todo) => applyAssignee(todo, input.agent))
      .map((todo) => applyTracker(todo, tracker))
    const existing = await readRepoStore()
    const existingTodos = existing.todos.map(normalizeTodo).map((todo) => applyTracker(todo, tracker))
    const existingById = new Map<string, Info>(existingTodos.map((todo) => [todo.id, todo]))
    const byId = new Map<string, Info>(existingTodos.map((todo) => [todo.id, todo]))
    const specGatedTodos = applySpecGate({
      todos,
      getPrevStatus: (todoId) => existingById.get(todoId)?.status,
    })
    const gatedTodos = await applyCheckpointGate({
      sessionID: input.sessionID,
      todos: specGatedTodos,
      getPrevStatus: (todoId) => existingById.get(todoId)?.status,
      tool: input.tool,
    })
    for (const todo of gatedTodos) {
      const prev = existingById.get(todo.id)
      const currentVersion = prev?.version ?? 0
      todo.version = prev ? currentVersion + 1 : 0
      byId.set(todo.id, todo)
    }
    const merged = Array.from(byId.values()).sort(sortTodos)
    await writeRepoStore(merged)
    const checkpointClosing = gatedTodos.filter((todo) => {
      if (!todo.checkpoint || !Task.isDoneStatus(todo.status)) return false
      const prev = existingById.get(todo.id)
      if (!prev) return true
      return !Task.isDoneStatus(prev.status)
    })
    const checkpointSnapshot =
      checkpointClosing.length > 0 ? await Snapshot.track().catch(() => undefined) : undefined
    await TaskHistory.record({
      tasks: gatedTodos,
      sessionID: input.sessionID,
      agent: input.agent,
      messageID: input.tool?.messageID,
      toolCallID: input.tool?.callID,
      checkpointSnapshot,
    }).catch(() => {})
    await TaskMetrics.updateMany(gatedTodos.map((todo) => todo.id)).catch(() => {})
    const stateTodos = input.agent
      ? merged.filter((todo) => (todo.assignee ?? input.agent) === input.agent)
      : merged
    await TaskState.updateRepo({
      agent: input.agent,
      todos: stateTodos,
      checkpointSnapshot,
    }).catch(() => {})
    return gatedTodos
  }

  export async function list(input?: { agent?: string; status?: string; limit?: number }) {
    const mode = await trackerMode()
    if (mode === "json") return listJson(input)
    return listBeads(input)
  }

  export async function ready(input?: { agent?: string; limit?: number }) {
    const mode = await trackerMode()
    if (mode === "json") return readyJson(input)
    return readyBeads(input)
  }

  export async function upsert(input: {
    sessionID?: string
    agent?: string
    todos: Info[]
    tool?: { messageID: string; callID?: string }
  }): Promise<Info[]> {
    const mode = await trackerMode()
    if (mode === "json") {
      return upsertJson(input)
    }
    return upsertBeads(input)
  }
}
