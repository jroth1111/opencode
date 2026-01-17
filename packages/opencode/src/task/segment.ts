import fs from "fs/promises"
import path from "path"
import { Global } from "@/global"
import { Instance } from "@/project/instance"
import { Identifier } from "@/id/id"

export namespace Segment {
  export type Mode = "autonomous" | "decision"
  export type Status = "queued" | "running" | "completed" | "failed"

  export type Info = {
    id: string
    todoId: string
    mode: Mode
    status: Status
    createdAt: string
    runIds: string[]
    budgetOverrides?: {
      maxChildren?: number
      maxDepth?: number
      maxOps?: number
    }
  }

  function segmentDir() {
    const base = Instance.project.vcs ? path.join(Instance.worktree, ".opencode") : Global.Path.data
    return path.join(base, "task-segments")
  }

  function segmentPath(segmentId: string) {
    return path.join(segmentDir(), `${segmentId}.json`)
  }

  async function writeSegment(segment: Info) {
    const dir = segmentDir()
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(segmentPath(segment.id), JSON.stringify(segment, null, 2))
  }

  async function readSegment(segmentId: string): Promise<Info | undefined> {
    const file = segmentPath(segmentId)
    const data = await Bun.file(file)
      .json()
      .catch(() => undefined)
    return data as Info | undefined
  }

  async function listSegments(): Promise<Info[]> {
    const dir = segmentDir()
    const entries = await fs.readdir(dir).catch(() => [])
    const segments = await Promise.all(
      entries
        .filter((name) => name.endsWith(".json"))
        .map((name) =>
          Bun.file(path.join(dir, name))
            .json()
            .then((data) => data as Info)
            .catch(() => undefined),
        ),
    )
    return segments.filter((segment): segment is Info => !!segment)
  }

  export async function create(input: {
    todoId: string
    mode: Mode
    budgetOverrides?: Info["budgetOverrides"]
  }) {
    const segment: Info = {
      id: Identifier.ascending("segment"),
      todoId: input.todoId,
      mode: input.mode,
      status: "queued",
      createdAt: new Date().toISOString(),
      runIds: [],
      budgetOverrides: input.budgetOverrides,
    }
    await writeSegment(segment)
    return segment
  }

  export async function get(segmentId: string) {
    return readSegment(segmentId)
  }

  export async function listByTodo(todoId: string) {
    const segments = await listSegments()
    return segments.filter((segment) => segment.todoId === todoId)
  }

  export async function addRun(segmentId: string, runId: string) {
    const segment = await readSegment(segmentId)
    if (!segment) return
    const runIds = new Set(segment.runIds)
    runIds.add(runId)
    const next: Info = {
      ...segment,
      runIds: Array.from(runIds),
    }
    await writeSegment(next)
    return next
  }

  export async function start(segmentId: string) {
    const segment = await readSegment(segmentId)
    if (!segment) return
    const next: Info = {
      ...segment,
      status: "running",
    }
    await writeSegment(next)
    return next
  }

  export async function complete(segmentId: string) {
    const segment = await readSegment(segmentId)
    if (!segment) return
    const next: Info = {
      ...segment,
      status: "completed",
    }
    await writeSegment(next)
    return next
  }

  export async function fail(segmentId: string) {
    const segment = await readSegment(segmentId)
    if (!segment) return
    const next: Info = {
      ...segment,
      status: "failed",
    }
    await writeSegment(next)
    return next
  }
}
