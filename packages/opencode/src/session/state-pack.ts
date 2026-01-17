import { Task } from "@/task"
import { TaskMetrics } from "@/task/metrics"
import { TaskState } from "@/task/state"
import { Todo } from "@/session/todo"
import fs from "fs/promises"
import path from "path"
import { Instance } from "@/project/instance"
import { Global } from "@/global"

const TOKEN_BUDGET = 700
const SECTION_LIMITS = {
  progress: 120,
  digest: 120,
  decisions: 80,
  blockers: 80,
  task: 260,
  metrics: 80,
  checkpoint: 40,
}

type BudgetSection = {
  name: string
  content: string
  maxTokens: number
}

function approxTokens(text: string) {
  return Math.ceil(text.length / 4)
}

function truncateToTokens(text: string, maxTokens: number) {
  if (maxTokens <= 0) return ""
  if (approxTokens(text) <= maxTokens) return text
  const maxChars = Math.max(0, maxTokens * 4)
  let truncated = text.slice(0, maxChars)
  const lastNewline = truncated.lastIndexOf("\n")
  if (lastNewline > 0) truncated = truncated.slice(0, lastNewline)
  truncated = truncated.trimEnd()
  return truncated.length ? `${truncated}\n…` : ""
}

function clampText(value: string | undefined, maxChars: number) {
  if (!value) return undefined
  const trimmed = value.trim()
  if (trimmed.length <= maxChars) return trimmed
  return trimmed.slice(0, Math.max(0, maxChars - 1)).trimEnd() + "…"
}

function hasUnresolvedDeps(todo: Task.Info, byId: Map<string, Task.Info>) {
  if (!todo.dependsOn || todo.dependsOn.length === 0) return false
  return todo.dependsOn.some((id) => {
    const dep = byId.get(id)
    if (!dep) return true
    return !Task.isDoneStatus(dep.status)
  })
}

function pickActiveTask(todos: Task.Info[]) {
  if (todos.length === 0) return
  const byId = new Map(todos.map((todo) => [todo.id, todo]))
  const normalized = todos.map(Task.normalize)
  const pickByStatus = (status: Task.Status, requireReady = false) => {
    const candidates = normalized.filter((todo) => {
      if (Task.normalizeStatus(todo.status) !== status) return false
      if (!requireReady) return true
      return !hasUnresolvedDeps(todo, byId)
    })
    if (candidates.length === 0) return
    return candidates.sort((a, b) => {
      const pa = Task.normalizePriority(a.priority)
      const pb = Task.normalizePriority(b.priority)
      if (pa !== pb) return pa - pb
      return a.content.localeCompare(b.content)
    })[0]
  }

  return (
    pickByStatus("in_progress") ||
    pickByStatus("open", true) ||
    pickByStatus("open") ||
    pickByStatus("blocked") ||
    normalized.sort((a, b) => a.content.localeCompare(b.content))[0]
  )
}

function renderDigest(state?: TaskState.Record) {
  const digest = state?.digest?.session
  if (!digest) return ""
  const lines: string[] = []
  lines.push("digest:")
  if (digest.inProgress.length) lines.push(`  in_progress: ${digest.inProgress.slice(0, 3).join(" | ")}`)
  if (digest.next.length) lines.push(`  next: ${digest.next.slice(0, 3).join(" | ")}`)
  if (digest.blocked.length) lines.push(`  blocked: ${digest.blocked.slice(0, 3).join(" | ")}`)
  if (digest.done.length) lines.push(`  done: ${digest.done.slice(0, 3).join(" | ")}`)
  return lines.join("\n")
}

function renderDecisions(state?: TaskState.Record) {
  const decisions = state?.decisions
    ?.map((item) => clampText(item, 200))
    .filter((item): item is string => Boolean(item))
  if (!decisions || decisions.length === 0) return ""
  return `decisions: ${decisions.slice(0, 3).join(" | ")}`
}

function renderBlockers(state?: TaskState.Record) {
  const blockers = state?.blockers
    ?.map((item) => clampText(item, 200))
    .filter((item): item is string => Boolean(item))
  if (!blockers || blockers.length === 0) return ""
  return `blockers: ${blockers.slice(0, 3).join(" | ")}`
}

function progressPath(sessionID: string) {
  const base = Instance.project.vcs
    ? path.join(Instance.worktree, ".opencode", "progress")
    : path.join(Global.Path.data, "progress")
  return path.join(base, `${sessionID}.md`)
}

async function renderProgress(sessionID: string) {
  const file = progressPath(sessionID)
  const content = await fs.readFile(file, "utf8").catch(() => "")
  if (!content.trim()) return ""
  const lines = content.trim().split("\n")
  const tail = lines.slice(-12)
  return ["progress:", ...tail].join("\n")
}

function renderTask(task: Task.Info) {
  const lines: string[] = []
  const deps = task.dependsOn?.length ?? 0
  lines.push(
    `task: id=${task.id}, status=${Task.normalizeStatus(task.status)}, prio=P${Task.normalizePriority(
      task.priority,
    )}, lane=${task.lane ?? "session"}, deps=${deps}`,
  )
  const verify = clampText(task.verify, 240)
  const done = clampText(task.done, 240)
  const action = clampText(task.action, 200)
  const files = task.files?.slice(0, 5)
  if (verify) lines.push(`verify: ${verify}`)
  if (done) lines.push(`done: ${done}`)
  if (action) lines.push(`action: ${action}`)
  if (files && files.length) lines.push(`files: ${files.join(", ")}`)
  return lines.join("\n")
}

function renderMetrics(metrics?: TaskMetrics.Metrics) {
  if (!metrics) return ""
  const lines: string[] = []
  lines.push(
    `metrics: attempts=${metrics.attempts.total}/${metrics.attempts.completed}/${metrics.attempts.failed}`,
  )
  if (metrics.totals?.cost !== undefined) lines.push(`  cost=${metrics.totals.cost.toFixed(4)}`)
  if (metrics.totals?.durationMs !== undefined) lines.push(`  duration_ms=${Math.round(metrics.totals.durationMs)}`)
  if (metrics.totals?.tokens) {
    const tokens = metrics.totals.tokens
    lines.push(`  tokens=in:${tokens.input},out:${tokens.output}`)
  }
  if (metrics.lastRun?.summary) lines.push(`  last_run="${clampText(metrics.lastRun.summary, 120)}"`)
  return lines.join("\n")
}

function renderCheckpoint(snapshot?: string) {
  if (!snapshot) return ""
  return `checkpoint: ${snapshot}`
}

export namespace StatePack {
  export async function build(input: { sessionID: string }) {
    const [state, todos] = await Promise.all([
      TaskState.get().catch(() => undefined),
      Todo.get(input.sessionID).catch(() => [] as Task.Info[]),
    ])

    const activeTask = pickActiveTask(todos)
    const metrics = activeTask ? await TaskMetrics.get(activeTask.id).catch(() => undefined) : undefined
    const checkpoint = metrics?.checkpoints?.lastSnapshot ?? state?.checkpoint?.snapshot

    const sections: BudgetSection[] = []
    const progress = await renderProgress(input.sessionID)
    if (progress) sections.push({ name: "progress", content: progress, maxTokens: SECTION_LIMITS.progress })
    const digest = renderDigest(state)
    if (digest) sections.push({ name: "digest", content: digest, maxTokens: SECTION_LIMITS.digest })
    const decisions = renderDecisions(state)
    if (decisions) sections.push({ name: "decisions", content: decisions, maxTokens: SECTION_LIMITS.decisions })
    const blockers = renderBlockers(state)
    if (blockers) sections.push({ name: "blockers", content: blockers, maxTokens: SECTION_LIMITS.blockers })
    if (activeTask) sections.push({ name: "task", content: renderTask(activeTask), maxTokens: SECTION_LIMITS.task })
    const metricsBlock = renderMetrics(metrics)
    if (metricsBlock) sections.push({ name: "metrics", content: metricsBlock, maxTokens: SECTION_LIMITS.metrics })
    const checkpointBlock = renderCheckpoint(checkpoint)
    if (checkpointBlock)
      sections.push({ name: "checkpoint", content: checkpointBlock, maxTokens: SECTION_LIMITS.checkpoint })

    if (sections.length === 0) return

    let remaining = TOKEN_BUDGET
    const body: string[] = []
    for (const section of sections) {
      if (remaining <= 0) break
      const maxTokens = Math.min(section.maxTokens, remaining)
      const trimmed = truncateToTokens(section.content, maxTokens)
      if (!trimmed) continue
      const tokens = approxTokens(trimmed)
      remaining -= tokens
      body.push(trimmed)
    }

    if (body.length === 0) return
    return `<state_pack>\n${body.join("\n")}\n</state_pack>`
  }
}
