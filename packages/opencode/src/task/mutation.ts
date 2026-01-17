import fs from "fs/promises"
import path from "path"
import { Global } from "@/global"
import { Instance } from "@/project/instance"

export namespace TaskMutation {
  export type Entry = {
    runId: string
    todoId: string
    timestamp: string
    before: unknown
    after: unknown
  }

  function baseDir() {
    const root = Instance.project.vcs ? path.join(Instance.worktree, ".opencode") : Global.Path.data
    return path.join(root, "task-runs")
  }

  function logPath(runId: string) {
    return path.join(baseDir(), `${runId}.mutations.jsonl`)
  }

  export async function record(entry: Omit<Entry, "timestamp">) {
    const dir = baseDir()
    await fs.mkdir(dir, { recursive: true })
    const payload: Entry = {
      ...entry,
      timestamp: new Date().toISOString(),
    }
    await fs.appendFile(logPath(entry.runId), JSON.stringify(payload) + "\n")
  }

  export async function list(runId: string): Promise<Entry[]> {
    const file = logPath(runId)
    const content = await fs.readFile(file, "utf8").catch(() => "")
    if (!content.trim()) return []
    return content
      .trim()
      .split("\n")
      .map((line) => {
        try {
          return JSON.parse(line) as Entry
        } catch {
          return undefined
        }
      })
      .filter((entry): entry is Entry => !!entry)
  }
}
