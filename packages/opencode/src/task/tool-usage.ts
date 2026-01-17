import { Config } from "@/config/config"
import { TaskRun } from "@/task/run"

export type ToolUsageMode = "high" | "all" | "none"

const FILE_WRITE_TOOLS = new Set(["edit", "write", "patch", "multiedit"])
const NETWORK_TOOLS = new Set(["webfetch", "websearch", "codesearch"])

function resolveToolUsageMode(config: Config.Info | undefined): ToolUsageMode {
  const mode = config?.task?.taskrun?.tool_usage
  if (mode === "all" || mode === "none" || mode === "high") return mode
  return "high"
}

function isGitCommand(command: unknown): boolean {
  if (typeof command !== "string") return false
  const trimmed = command.trim()
  if (!trimmed) return false
  return /\bgit\b/.test(trimmed)
}

function classifyToolUsage(tool: string, args: unknown, mode: ToolUsageMode): string[] {
  if (mode === "none") return []

  if (mode === "all") {
    if (tool === "todo" && typeof (args as any)?.action === "string") {
      return [`todo.${(args as any).action}`]
    }
    return [tool]
  }

  if (tool === "todo") {
    if (typeof (args as any)?.action === "string") {
      return [`todo.${(args as any).action}`]
    }
    return ["todo"]
  }

  if (FILE_WRITE_TOOLS.has(tool)) return ["file.write"]

  if (tool === "bash") {
    const command = (args as any)?.command
    return isGitCommand(command) ? ["git"] : ["shell.exec"]
  }

  if (NETWORK_TOOLS.has(tool)) return ["net.search"]

  return []
}

export async function recordToolUsageForSession(input: {
  sessionID: string
  tool: string
  args?: unknown
  mode?: ToolUsageMode
  config?: Config.Info
}) {
  const run = await TaskRun.getActiveBySession(input.sessionID)
  if (!run) return
  const mode = input.mode ?? resolveToolUsageMode(input.config ?? (await Config.get()))
  const names = classifyToolUsage(input.tool, input.args, mode)
  if (names.length === 0) return
  await Promise.all(names.map((name) => TaskRun.recordToolUsage(run.id, name).catch(() => {})))
}

export async function recordToolUsageForRun(input: {
  runId: string
  tool: string
  args?: unknown
  mode?: ToolUsageMode
  config?: Config.Info
}) {
  const mode = input.mode ?? resolveToolUsageMode(input.config ?? (await Config.get()))
  const names = classifyToolUsage(input.tool, input.args, mode)
  if (names.length === 0) return
  await Promise.all(names.map((name) => TaskRun.recordToolUsage(input.runId, name).catch(() => {})))
}

export function toolUsageModeFromConfig(config: Config.Info | undefined): ToolUsageMode {
  return resolveToolUsageMode(config)
}
