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
  }
  return {
    title: task.content,
    status: meta.status,
    priority: meta.priority,
    issue_type: "task",
    description: encodeMeta(meta),
    external_ref: options?.externalRef,
  }
}

export function beadsIssueToTask(issue: BeadsIssue, options?: { id?: string }): Task.Info {
  const meta = extractMeta(issue.description)
  const checkpoint = meta?.checkpoint ?? TaskLabels.isCheckpoint(issue.labels)
  const lane = meta?.lane ?? (TaskLabels.isRepoLabel(issue.labels) ? "repo" : "session")
  return Task.normalize({
    id: options?.id ?? meta?.id ?? issue.external_ref ?? issue.id,
    content: issue.title,
    status: Task.normalizeStatus(issue.status ?? meta?.status),
    priority: Task.normalizePriority(issue.priority ?? meta?.priority),
    lane,
    checkpoint,
  })
}

export function taskToUI(task: Task.Info): Task.Info {
  return Task.normalize(task)
}

export function uiToTask(task: Task.Info): Task.Info {
  return Task.normalize(task)
}
