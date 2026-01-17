import fs from "fs/promises"
import path from "path"
import { Global } from "@/global"
import { Instance } from "@/project/instance"
import { Task } from "@/task"
import { TaskHistory } from "@/task/history"
import { TaskRun } from "@/task/run"

export namespace TaskMetrics {
  type Tokens = NonNullable<TaskHistory.Entry["tokens"]>

  export type Metrics = {
    taskId: string
    updatedAt: string
    activity: {
      firstSeen?: string
      lastSeen?: string
    }
    totals: {
      cost?: number
      durationMs?: number
      tokens?: Tokens
    }
    attempts: {
      total: number
      completed: number
      failed: number
      cancelled: number
      running: number
      queued: number
      retries: number
    }
    lastStatus?: Task.Status
    lastRun?: {
      id: string
      status: TaskRun.Status
      startedAt?: string
      finishedAt?: string
      durationMs?: number
      summary?: string
      error?: string
    }
    runs: Array<{
      id: string
      status: TaskRun.Status
      startedAt?: string
      finishedAt?: string
      durationMs?: number
      summary?: string
      error?: string
    }>
    history: TaskHistory.Entry[]
    checkpoints?: {
      snapshots: string[]
      lastSnapshot?: string
    }
  }

  function metricsDir() {
    const base = Instance.project.vcs
      ? path.join(Instance.worktree, ".opencode")
      : Global.Path.data
    return path.join(base, "task-metrics")
  }

  function metricsPath(taskId: string) {
    return path.join(metricsDir(), `${taskId}.json`)
  }

  function emptyTokens(): Tokens {
    return {
      input: 0,
      output: 0,
      reasoning: 0,
      cache: {
        read: 0,
        write: 0,
      },
    }
  }

  function addTokens(base: Tokens, add: Tokens) {
    return {
      input: base.input + add.input,
      output: base.output + add.output,
      reasoning: base.reasoning + add.reasoning,
      cache: {
        read: base.cache.read + add.cache.read,
        write: base.cache.write + add.cache.write,
      },
    }
  }

  function hasTokenUsage(tokens: Tokens) {
    return tokens.input > 0 || tokens.output > 0 || tokens.reasoning > 0 || tokens.cache.read > 0 || tokens.cache.write > 0
  }

  function computeAttemptSummary(runs: TaskRun.Info[]) {
    const counts = {
      total: runs.length,
      completed: 0,
      failed: 0,
      budget_exhausted: 0,
      cancelled: 0,
      running: 0,
      queued: 0,
      retries: 0,
    }
    for (const run of runs) {
      switch (run.status) {
        case "completed":
          counts.completed += 1
          break
        case "failed":
          counts.failed += 1
          break
        case "budget_exhausted":
          counts.failed += 1
          counts.budget_exhausted += 1
          break
        case "cancelled":
          counts.cancelled += 1
          break
        case "running":
          counts.running += 1
          break
        case "queued":
          counts.queued += 1
          break
      }
    }
    counts.retries = Math.max(0, counts.total - 1)
    return counts
  }

  function latestRun(runs: TaskRun.Info[]) {
    if (runs.length === 0) return undefined
    const sorted = [...runs].sort((a, b) => {
      const aTime = a.finishedAt ?? a.startedAt ?? ""
      const bTime = b.finishedAt ?? b.startedAt ?? ""
      return bTime.localeCompare(aTime)
    })
    const run = sorted[0]
    return {
      id: run.id,
      status: run.status,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      durationMs: run.durationMs,
      summary: run.summary,
      error: run.error,
    }
  }

  function serializeRuns(runs: TaskRun.Info[]) {
    return runs
      .sort((a, b) => {
        const aTime = a.startedAt ?? ""
        const bTime = b.startedAt ?? ""
        return aTime.localeCompare(bTime)
      })
      .map((run) => ({
        id: run.id,
        status: run.status,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
        durationMs: run.durationMs,
        summary: run.summary,
        error: run.error,
      }))
  }

  async function compute(taskId: string): Promise<Metrics> {
    const history = await TaskHistory.list(taskId)
    const runs = await TaskRun.listByTodo(taskId)

    const timestamps = history.map((entry) => entry.timestamp).filter(Boolean)
    const sortedTimestamps = [...timestamps].sort()
    let firstSeen = sortedTimestamps[0]
    let lastSeen = sortedTimestamps[sortedTimestamps.length - 1]
    if (!firstSeen || !lastSeen) {
      const runTimes = runs
        .map((run) => run.startedAt ?? run.finishedAt)
        .filter(Boolean) as string[]
      const sortedRuns = runTimes.sort()
      firstSeen = firstSeen ?? sortedRuns[0]
      lastSeen = lastSeen ?? sortedRuns[sortedRuns.length - 1]
    }

    const totalCost = history.reduce((sum, entry) => sum + (entry.cost ?? 0), 0)
    const totalDuration = history.reduce((sum, entry) => sum + (entry.durationMs ?? 0), 0)
    const tokens = history.reduce((acc, entry) => (entry.tokens ? addTokens(acc, entry.tokens) : acc), emptyTokens())

    const checkpointSnapshots = Array.from(
      new Set(history.map((entry) => entry.checkpointSnapshot).filter(Boolean) as string[]),
    )

    const lastEntry = history[history.length - 1]
    const lastStatus =
      lastEntry && lastEntry.status ? Task.normalizeStatus(lastEntry.status) : undefined

    return {
      taskId,
      updatedAt: new Date().toISOString(),
      activity: {
        firstSeen,
        lastSeen,
      },
      totals: {
        cost: totalCost > 0 ? totalCost : undefined,
        durationMs: totalDuration > 0 ? totalDuration : undefined,
        tokens: hasTokenUsage(tokens) ? tokens : undefined,
      },
      attempts: computeAttemptSummary(runs),
      lastStatus,
      lastRun: latestRun(runs),
      runs: serializeRuns(runs),
      history,
      checkpoints: checkpointSnapshots.length
        ? {
            snapshots: checkpointSnapshots,
            lastSnapshot: checkpointSnapshots[checkpointSnapshots.length - 1],
          }
        : undefined,
    }
  }

  async function write(metrics: Metrics) {
    const dir = metricsDir()
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(metricsPath(metrics.taskId), JSON.stringify(metrics, null, 2))
  }

  export async function update(taskId: string) {
    const metrics = await compute(taskId)
    await write(metrics)
    return metrics
  }

  export async function updateMany(taskIds: string[]) {
    const unique = Array.from(new Set(taskIds.filter(Boolean)))
    await Promise.all(unique.map((taskId) => update(taskId)))
  }

  export async function get(taskId: string, refresh = false): Promise<Metrics> {
    if (!refresh) {
      const existing = await fs
        .readFile(metricsPath(taskId), "utf8")
        .then((content) => JSON.parse(content) as Metrics)
        .catch(() => undefined)
      if (existing) return existing
    }
    return update(taskId)
  }
}
