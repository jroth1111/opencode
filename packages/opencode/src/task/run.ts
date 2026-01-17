import fs from "fs/promises"
import path from "path"
import { Global } from "@/global"
import { Instance } from "@/project/instance"
import { Identifier } from "@/id/id"
import { cleanupDraftChildren } from "./cleanup"

export namespace TaskRun {
  export type Status = "queued" | "running" | "completed" | "failed" | "cancelled" | "budget_exhausted"

  export type Scope = {
    rootTodoId: string
    createdChildIds: string[]
  }

  export type Budgets = {
    maxChildren: number
    maxDepth: number
    maxOps: number
  }

  export type Counters = {
    childrenCreated: number
    depthRemaining: number
    opsUsed: number
  }

  export type WriteSet = {
    fields: string[]
  }

  export type ToolUsage = {
    name: string
    count: number
  }

  export type Info = {
    id: string
    todoId: string
    todoSessionId?: string
    todoLane?: "session" | "repo"
    sessionId: string
    agentType: string
    segmentId?: string
    capabilityTokenId?: string
    status: Status
    scope: Scope
    budgets: Budgets
    counters: Counters
    writeSet: WriteSet
    toolUsage: ToolUsage[]
    startedAt?: string
    finishedAt?: string
    durationMs?: number
    summary?: string
    error?: string
    observed?: Record<string, { version: number; snapshot: Record<string, unknown> }>
  }

  function runDir() {
    const base = Instance.project.vcs ? path.join(Instance.worktree, ".opencode") : Global.Path.data
    return path.join(base, "task-runs")
  }

  function runPath(runId: string) {
    return path.join(runDir(), `${runId}.json`)
  }

  async function writeRun(run: Info) {
    const dir = runDir()
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(runPath(run.id), JSON.stringify(run, null, 2))
  }

  async function readRun(runId: string): Promise<Info | undefined> {
    const file = runPath(runId)
    const data = await Bun.file(file)
      .json()
      .catch(() => undefined)
    const run = data as Info | undefined
    if (run && (run as any).scope?.todoId && !(run as any).scope?.rootTodoId) {
      ;(run as any).scope = {
        ...(run as any).scope,
        rootTodoId: (run as any).scope.todoId,
      }
      delete (run as any).scope.todoId
    }
    if (run && !(run as any).budgets && (run as any).maxChildren !== undefined) {
      run.budgets = {
        maxChildren: (run as any).maxChildren ?? 5,
        maxDepth: (run as any).depthRemaining ?? 2,
        maxOps: 50,
      }
    }
    if (run && !run.budgets) {
      run.budgets = { maxChildren: 5, maxDepth: 2, maxOps: 50 }
    }
    if (run && !run.counters) {
      run.counters = {
        childrenCreated: run.scope.createdChildIds.length,
        depthRemaining: (run as any).depthRemaining ?? run.budgets.maxDepth,
        opsUsed: 0,
      }
    }
    if (run && !run.writeSet) run.writeSet = { fields: [] }
    if (run && !run.toolUsage) run.toolUsage = []
    return run
  }

  async function listRuns(): Promise<Info[]> {
    const dir = runDir()
    const entries = await fs.readdir(dir).catch(() => [])
    const runs = await Promise.all(
      entries
        .filter((name) => name.endsWith(".json"))
        .map((name) =>
          Bun.file(path.join(dir, name))
            .json()
            .then((data) => data as Info)
            .catch(() => undefined),
        ),
    )
    return runs.filter((run): run is Info => !!run)
  }

  export async function create(input: {
    todoId: string
    todoSessionId?: string
    todoLane?: "session" | "repo"
    sessionId: string
    agentType: string
    segmentId?: string
    capabilityTokenId?: string
    maxChildren?: number
    depthRemaining?: number
    maxOps?: number
  }) {
    const budgets: Budgets = {
      maxChildren: input.maxChildren ?? 5,
      maxDepth: input.depthRemaining ?? 2,
      maxOps: input.maxOps ?? 50,
    }
    const counters: Counters = {
      childrenCreated: 0,
      depthRemaining: budgets.maxDepth,
      opsUsed: 0,
    }
    const run: Info = {
      id: Identifier.ascending("run"),
      todoId: input.todoId,
      todoSessionId: input.todoSessionId,
      todoLane: input.todoLane,
      sessionId: input.sessionId,
      agentType: input.agentType,
      segmentId: input.segmentId,
      capabilityTokenId: input.capabilityTokenId,
      status: "queued",
      scope: {
        rootTodoId: input.todoId,
        createdChildIds: [],
      },
      budgets,
      counters,
      writeSet: { fields: [] },
      toolUsage: [],
    }
    await writeRun(run)
    return run
  }

  export async function get(runId: string) {
    return readRun(runId)
  }

  export async function listByTodo(todoId: string) {
    const runs = await listRuns()
    return runs.filter((run) => run.todoId === todoId)
  }

  export async function listBySession(sessionId: string) {
    const runs = await listRuns()
    return runs.filter((run) => run.sessionId === sessionId)
  }

  export async function getActiveBySession(sessionId: string) {
    const runs = await listBySession(sessionId)
    const running = runs.filter((run) => run.status === "running")
    if (running.length === 0) return
    return running.sort((a, b) => (b.startedAt ?? "").localeCompare(a.startedAt ?? ""))[0]
  }

  export async function start(runId: string) {
    const run = await readRun(runId)
    if (!run) return
    const startedAt = new Date().toISOString()
    const next: Info = {
      ...run,
      status: "running",
      startedAt,
    }
    await writeRun(next)
    return next
  }

  export async function complete(runId: string, input?: { summary?: string; cleanupMode?: "close" | "archive" }) {
    const run = await readRun(runId)
    if (!run) return
    const finishedAt = new Date().toISOString()
    const durationMs =
      run.startedAt && Date.parse(finishedAt) > Date.parse(run.startedAt)
        ? Date.parse(finishedAt) - Date.parse(run.startedAt)
        : undefined
    const next: Info = {
      ...run,
      status: "completed",
      finishedAt,
      durationMs,
      summary: input?.summary ?? run.summary,
    }
    await writeRun(next)
    await cleanupDraftChildren(runId, { mode: input?.cleanupMode }).catch(() => {})
    return next
  }

  export async function fail(
    runId: string,
    input?: { error?: string; cancelled?: boolean; status?: Status; cleanupMode?: "close" | "archive" },
  ) {
    const run = await readRun(runId)
    if (!run) return
    const finishedAt = new Date().toISOString()
    const durationMs =
      run.startedAt && Date.parse(finishedAt) > Date.parse(run.startedAt)
        ? Date.parse(finishedAt) - Date.parse(run.startedAt)
        : undefined
    const next: Info = {
      ...run,
      status: input?.status ?? (input?.cancelled ? "cancelled" : "failed"),
      finishedAt,
      durationMs,
      error: input?.error ?? run.error,
    }
    await writeRun(next)
    await cleanupDraftChildren(runId, { mode: input?.cleanupMode }).catch(() => {})
    return next
  }

  export async function addChild(runId: string, childId: string) {
    const run = await readRun(runId)
    if (!run) return
    const created = new Set(run.scope.createdChildIds)
    if (created.size >= run.budgets.maxChildren) {
      throw new Error(`TaskRun ${runId} exceeded maxChildren (${run.budgets.maxChildren})`)
    }
    created.add(childId)
    const next: Info = {
      ...run,
      scope: {
        ...run.scope,
        createdChildIds: Array.from(created),
      },
      counters: {
        ...run.counters,
        childrenCreated: created.size,
      },
    }
    await writeRun(next)
    return next
  }

  export async function consumeDepth(runId: string) {
    const run = await readRun(runId)
    if (!run) return
    if (run.counters.depthRemaining <= 0) {
      throw new Error(`TaskRun ${runId} depthRemaining exhausted`)
    }
    const next: Info = {
      ...run,
      counters: {
        ...run.counters,
        depthRemaining: run.counters.depthRemaining - 1,
      },
    }
    await writeRun(next)
    return next
  }

  export async function syncCapabilityDepth(runId: string) {
    const run = await readRun(runId)
    if (!run?.capabilityTokenId) return
    const tokenMod = await import("./capability")
    const token = await tokenMod.CapabilityToken.get(run.capabilityTokenId)
    if (!token) return
    if (token.depthRemaining === run.counters.depthRemaining) return
    const updated = {
      ...token,
      depthRemaining: run.counters.depthRemaining,
    }
    // Re-sign by creating a replacement token in-place
    await tokenMod.CapabilityToken.revoke(token.id).catch(() => {})
    const replacement = await tokenMod.CapabilityToken.create({
      runId: run.id,
      scope: token.scope,
      depthRemaining: run.counters.depthRemaining,
      expiresAt: token.expiresAt,
    })
    await TaskRun.attachCapability(run.id, replacement.id)
  }

  export class BudgetExceededError extends Error {
    code = "BUDGET_EXHAUSTED" as const
    constructor(message: string) {
      super(message)
      this.name = "BudgetExceededError"
    }
  }

  export async function consumeOps(runId: string, amount = 1) {
    const run = await readRun(runId)
    if (!run) return
    const nextOps = run.counters.opsUsed + amount
    if (nextOps > run.budgets.maxOps) {
      throw new BudgetExceededError(`TaskRun ${runId} exceeded maxOps (${run.budgets.maxOps})`)
    }
    const next: Info = {
      ...run,
      counters: {
        ...run.counters,
        opsUsed: nextOps,
      },
    }
    await writeRun(next)
    return next
  }

  export async function attachCapability(runId: string, tokenId: string) {
    const run = await readRun(runId)
    if (!run) return
    const next: Info = {
      ...run,
      capabilityTokenId: tokenId,
    }
    await writeRun(next)
    return next
  }

  export async function attachSegment(runId: string, segmentId: string) {
    const run = await readRun(runId)
    if (!run) return
    const next: Info = {
      ...run,
      segmentId,
    }
    await writeRun(next)
    return next
  }

  export async function recordWrite(runId: string, fields: string[]) {
    const run = await readRun(runId)
    if (!run) return
    const nextFields = new Set(run.writeSet?.fields ?? [])
    fields.forEach((field) => nextFields.add(field))
    const next: Info = {
      ...run,
      writeSet: {
        fields: Array.from(nextFields),
      },
    }
    await writeRun(next)
    return next
  }

  export async function recordToolUsage(runId: string, toolName: string) {
    const run = await readRun(runId)
    if (!run) return
    const usage = new Map((run.toolUsage ?? []).map((item) => [item.name, item.count]))
    usage.set(toolName, (usage.get(toolName) ?? 0) + 1)
    const next: Info = {
      ...run,
      toolUsage: Array.from(usage.entries()).map(([name, count]) => ({ name, count })),
    }
    await writeRun(next)
    return next
  }

  export async function recordObserved(
    runId: string,
    todoId: string,
    input: { version: number; snapshot: Record<string, unknown> },
  ) {
    const run = await readRun(runId)
    if (!run) return
    const next: Info = {
      ...run,
      observed: {
        ...(run.observed ?? {}),
        [todoId]: {
          version: input.version,
          snapshot: input.snapshot,
        },
      },
    }
    await writeRun(next)
    return next
  }

  export async function cleanupDraftChildren(runId: string, input?: { mode?: "close" | "archive" }) {
    const mod = await import("./cleanup")
    await mod.cleanupDraftChildren(runId, input)
  }
}
