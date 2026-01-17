import { Task } from "./index"
import { TaskLabels } from "./labels"
import type { BeadsIssue, BeadsIssueInput } from "@/beads/protocol"

const META_PREFIX = "OPENCODE_META:"

export type TaskMeta = {
  v: 1
  id: string
  session?: string
  agent?: string
  status?: Task.Status
  priority?: Task.Priority
  lane?: Task.Lane
  checkpoint?: boolean
  issueType?: string
  tracker?: Task.Tracker
  files?: string[]
  action?: string
  verify?: string
  done?: string
  dependsOn?: string[]
  blocks?: string[]
  parentId?: string
  assignee?: string
  estimateMinutes?: number
  version?: number
}

function encodeMeta(meta: TaskMeta) {
  return `${META_PREFIX}${JSON.stringify(meta)}`
}

function extractMeta(description?: string | null): TaskMeta | undefined {
  if (!description) return
  const line = description.split("\n").find((item) => item.startsWith(META_PREFIX))
  if (!line) return
  const payload = line.slice(META_PREFIX.length).trim()
  if (!payload) return
  try {
    return JSON.parse(payload) as TaskMeta
  } catch {
    return
  }
}

function formatNotes(task: Task.Info): string | undefined {
  const lines: string[] = []
  if (task.files && task.files.length > 0) {
    lines.push("Files:")
    for (const file of task.files) lines.push(`- ${file}`)
    lines.push("")
  }
  if (task.verify) {
    lines.push("Verify:")
    lines.push(task.verify)
    lines.push("")
  }
  const rendered = lines.join("\n").trim()
  return rendered.length ? rendered : undefined
}

function parseNotes(notes?: string | null): { files?: string[]; verify?: string } {
  if (!notes) return {}
  const lines = notes.split("\n")
  const files: string[] = []
  let verify: string | undefined
  let current: "files" | "verify" | undefined
  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue
    if (/^files:?$/i.test(line)) {
      current = "files"
      continue
    }
    if (/^verify:?$/i.test(line)) {
      current = "verify"
      verify = ""
      continue
    }
    if (current === "files") {
      const cleaned = line.replace(/^[-*]\s*/, "")
      if (cleaned) files.push(cleaned)
      continue
    }
    if (current === "verify") {
      verify = verify ? `${verify}\n${line}` : line
    }
  }
  return {
    files: files.length ? files : undefined,
    verify: verify?.trim().length ? verify.trim() : undefined,
  }
}

function normalizeDependencies(ids?: string[]) {
  if (!ids || ids.length === 0) return undefined
  const normalized = Array.from(
    new Set(
      ids
        .map((id) => id?.toString().trim())
        .filter((id): id is string => !!id),
    ),
  )
  return normalized.length ? normalized : undefined
}

export function taskToBeadsIssue(
  task: Task.Info,
  options?: { sessionID?: string; agent?: string; externalRef?: string },
): BeadsIssueInput {
  const meta: TaskMeta = {
    v: 1,
    id: task.id,
    session: options?.sessionID,
    agent: options?.agent,
    status: Task.normalizeStatus(task.status),
    priority: Task.normalizePriority(task.priority),
    lane: Task.normalizeLane(task.lane),
    checkpoint: task.checkpoint ? true : undefined,
    issueType: task.issueType,
    tracker: task.tracker,
    files: task.files,
    action: task.action,
    verify: task.verify,
    done: task.done,
    dependsOn: normalizeDependencies(task.dependsOn),
    blocks: normalizeDependencies(task.blocks),
    parentId: task.parentId,
    assignee: task.assignee,
    estimateMinutes: task.estimateMinutes,
    version: task.version,
  }
  const dependencies = normalizeDependencies(task.dependsOn)?.map((id) => `blocks:${id}`)
  return {
    title: task.content,
    status: meta.status,
    priority: meta.priority,
    issue_type: task.issueType ?? "task",
    description: encodeMeta(meta),
    external_ref: options?.externalRef,
    assignee: task.assignee,
    design: task.action,
    acceptance_criteria: task.done,
    notes: formatNotes(task),
    dependencies,
    parent: task.parentId,
    estimated_minutes: task.estimateMinutes,
  }
}

export function beadsIssueToTask(issue: BeadsIssue, options?: { id?: string }): Task.Info {
  const meta = extractMeta(issue.description)
  const parsedNotes = parseNotes(issue.notes)
  const dependencyIds =
    issue.dependencies
      ?.filter((dep) => !dep.dependency_type || dep.dependency_type === "blocks")
      .map((dep) => dep.id)
      .filter((id) => typeof id === "string") ?? undefined
  const dependentIds =
    issue.dependents
      ?.filter((dep) => !dep.dependency_type || dep.dependency_type === "blocks")
      .map((dep) => dep.id)
      .filter((id) => typeof id === "string") ?? undefined
  const dependsOn = normalizeDependencies(meta?.dependsOn ?? dependencyIds)
  const checkpoint = meta?.checkpoint ?? TaskLabels.isCheckpoint(issue.labels)
  const lane = meta?.lane ?? (TaskLabels.isRepoLabel(issue.labels) ? "repo" : "session")
  return Task.normalize({
    id: options?.id ?? meta?.id ?? issue.external_ref ?? issue.id,
    content: issue.title,
    status: Task.normalizeStatus(issue.status ?? meta?.status),
    priority: Task.normalizePriority(issue.priority ?? meta?.priority),
    lane,
    checkpoint,
    issueType: meta?.issueType ?? issue.issue_type,
    tracker: meta?.tracker ?? { id: "beads", mode: lane },
    files: meta?.files ?? parsedNotes.files,
    action: meta?.action ?? issue.design,
    verify: meta?.verify ?? parsedNotes.verify,
    done: meta?.done ?? issue.acceptance_criteria,
    dependsOn,
    blocks: normalizeDependencies(meta?.blocks ?? dependentIds),
    parentId: meta?.parentId ?? issue.parent,
    assignee: meta?.assignee ?? issue.assignee,
    estimateMinutes: meta?.estimateMinutes ?? issue.estimated_minutes,
    version: meta?.version ?? 0,
  })
}

export function taskToUI(task: Task.Info): Task.Info {
  return Task.normalize(task)
}

export function uiToTask(task: Task.Info): Task.Info {
  return Task.normalize(task)
}
