import fs from "fs/promises"
import path from "path"
import { Global } from "@/global"
import { Instance } from "@/project/instance"
import { MessageV2 } from "@/session/message-v2"
import { Task } from "@/task"
import { Log } from "@/util/log"

export namespace TaskHistory {
  const log = Log.create({ service: "task.history" })

  export type Entry = {
    taskId: string
    sessionID?: string
    agent?: string
    lane?: Task.Lane
    status?: Task.Status
    timestamp: string
    messageID?: string
    toolCallID?: string
    cost?: number
    tokens?: MessageV2.Assistant["tokens"]
    durationMs?: number
    checkpointSnapshot?: string
    warnings?: string[]
  }

  function historyDir() {
    const base = Instance.project.vcs
      ? path.join(Instance.worktree, ".opencode", "task-history")
      : path.join(Global.Path.data, "task-history")
    return base
  }

  async function writeEntry(taskId: string, entry: Entry) {
    const dir = historyDir()
    await fs.mkdir(dir, { recursive: true })
    const file = path.join(dir, `${taskId}.jsonl`)
    await fs.appendFile(file, JSON.stringify(entry) + "\n")
  }

  export async function list(taskId: string): Promise<Entry[]> {
    const file = path.join(historyDir(), `${taskId}.jsonl`)
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

  async function getUsage(input: { sessionID?: string; messageID?: string }) {
    if (!input.sessionID || !input.messageID) return {}
    const message = await MessageV2.get({ sessionID: input.sessionID, messageID: input.messageID }).catch(() => undefined)
    if (!message || message.info.role !== "assistant") return {}
    const durationMs =
      message.info.time.completed && message.info.time.completed > message.info.time.created
        ? message.info.time.completed - message.info.time.created
        : undefined
    return {
      cost: message.info.cost,
      tokens: message.info.tokens,
      durationMs,
    }
  }

  function specWarnings(task: Task.Info) {
    if (Task.normalizeStatus(task.status) !== "closed") return
    const warnings: string[] = []
    if (!task.files || task.files.length === 0) warnings.push("missing files")
    if (!task.action) warnings.push("missing action")
    return warnings.length ? warnings : undefined
  }

  export async function record(input: {
    tasks: Task.Info[]
    sessionID?: string
    agent?: string
    messageID?: string
    toolCallID?: string
    checkpointSnapshot?: string
  }) {
    if (input.tasks.length === 0) return
    const usage = await getUsage({ sessionID: input.sessionID, messageID: input.messageID })
    const timestamp = new Date().toISOString()
    await Promise.all(
      input.tasks.map((task) => {
        const warnings = specWarnings(task)
        if (warnings) {
          log.warn("task closed without optional spec fields", { taskId: task.id, warnings })
        }
        return writeEntry(task.id, {
          taskId: task.id,
          sessionID: input.sessionID,
          agent: input.agent,
          lane: task.lane,
          status: Task.normalizeStatus(task.status),
          timestamp,
          messageID: input.messageID,
          toolCallID: input.toolCallID,
          cost: usage.cost,
          tokens: usage.tokens,
          durationMs: usage.durationMs,
          checkpointSnapshot:
            input.checkpointSnapshot && task.checkpoint && Task.isDoneStatus(task.status)
              ? input.checkpointSnapshot
              : undefined,
          warnings,
        })
      }),
    )
  }
}
