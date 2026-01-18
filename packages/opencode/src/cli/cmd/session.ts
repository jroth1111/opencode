import type { Argv } from "yargs"
import { cmd } from "./cmd"
import { Session } from "../../session"
import { bootstrap } from "../bootstrap"
import { UI } from "../ui"
import { Locale } from "../../util/locale"
import { Flag } from "../../flag/flag"
import { EOL } from "os"
import path from "path"
import { Todo } from "../../session/todo"
import { Task } from "../../task"
import {
  isKickoffComplete,
  mergeState,
  planModeFor,
  resolveConfig,
  webSearchGateStatus,
} from "../../session/workflow"

function pagerCmd(): string[] {
  const lessOptions = ["-R", "-S"]
  if (process.platform !== "win32") {
    return ["less", ...lessOptions]
  }

  // user could have less installed via other options
  const lessOnPath = Bun.which("less")
  if (lessOnPath) {
    if (Bun.file(lessOnPath).size) return [lessOnPath, ...lessOptions]
  }

  if (Flag.OPENCODE_GIT_BASH_PATH) {
    const less = path.join(Flag.OPENCODE_GIT_BASH_PATH, "..", "..", "usr", "bin", "less.exe")
    if (Bun.file(less).size) return [less, ...lessOptions]
  }

  const git = Bun.which("git")
  if (git) {
    const less = path.join(git, "..", "..", "usr", "bin", "less.exe")
    if (Bun.file(less).size) return [less, ...lessOptions]
  }

  // Fall back to Windows built-in more (via cmd.exe)
  return ["cmd", "/c", "more"]
}

export const SessionCommand = cmd({
  command: "session",
  describe: "manage sessions",
  builder: (yargs: Argv) => yargs.command(SessionListCommand).command(SessionStatusCommand).demandCommand(),
  async handler() {},
})

export const SessionListCommand = cmd({
  command: "list",
  describe: "list sessions",
  builder: (yargs: Argv) => {
    return yargs
      .option("max-count", {
        alias: "n",
        describe: "limit to N most recent sessions",
        type: "number",
      })
      .option("format", {
        describe: "output format",
        type: "string",
        choices: ["table", "json"],
        default: "table",
      })
  },
  handler: async (args) => {
    await bootstrap(process.cwd(), async () => {
      const sessions = []
      for await (const session of Session.list()) {
        if (!session.parentID) {
          sessions.push(session)
        }
      }

      sessions.sort((a, b) => b.time.updated - a.time.updated)

      const limitedSessions = args.maxCount ? sessions.slice(0, args.maxCount) : sessions

      if (limitedSessions.length === 0) {
        return
      }

      let output: string
      if (args.format === "json") {
        output = formatSessionJSON(limitedSessions)
      } else {
        output = formatSessionTable(limitedSessions)
      }

      const shouldPaginate = process.stdout.isTTY && !args.maxCount && args.format === "table"

      if (shouldPaginate) {
        const proc = Bun.spawn({
          cmd: pagerCmd(),
          stdin: "pipe",
          stdout: "inherit",
          stderr: "inherit",
        })

        proc.stdin.write(output)
        proc.stdin.end()
        await proc.exited
      } else {
        console.log(output)
      }
    })
  },
})

type WorkflowGateStatus = {
  id: string
  title: string
  mode: "minimal" | "workflow"
  track?: "fast" | "full"
  kickoff: {
    complete: boolean
    required: boolean
  }
  plan: {
    mode: "auto" | "always" | "off"
    required: boolean
    approved: boolean
  }
  verify: {
    required: boolean
  }
  todos: {
    total: number
    blocking: number
  }
  webSearchGate: ReturnType<typeof webSearchGateStatus>
}

export const SessionStatusCommand = cmd({
  command: "status [sessionID]",
  describe: "show workflow gate status for a session",
  builder: (yargs: Argv) => {
    return yargs
      .positional("sessionID", {
        describe: "session id to inspect",
        type: "string",
      })
      .option("format", {
        describe: "output format",
        type: "string",
        choices: ["table", "json"],
        default: "table",
      })
  },
  handler: async (args) => {
    await bootstrap(process.cwd(), async () => {
      let sessionID = args.sessionID
      if (!sessionID) {
        const sessions = []
        for await (const session of Session.list()) {
          if (!session.parentID) sessions.push(session)
        }
        sessions.sort((a, b) => b.time.updated - a.time.updated)
        sessionID = sessions[0]?.id
      }

      if (!sessionID) {
        UI.error("No sessions found")
        process.exit(1)
      }

      let session: Session.Info
      try {
        session = await Session.get(sessionID)
      } catch {
        UI.error(`Session not found: ${sessionID}`)
        process.exit(1)
        return
      }

      const workflowConfig = await resolveConfig()
      const workflowState = mergeState(session.workflow, workflowConfig)
      const mode = (workflowState.mode ?? workflowConfig.mode) as "minimal" | "workflow"
      const planMode = planModeFor(workflowConfig, mode)
      const kickoffComplete = isKickoffComplete(workflowState.kickoff)
      const kickoffRequired = mode === "workflow"
      const planApproved = !!workflowState.plan?.approved
      const planRequired = planMode !== "off" && !!workflowState.plan?.required && !planApproved
      const verifyRequired = !!(workflowConfig.verify.afterEdit && workflowState.verify?.required)
      const todos = await Todo.get(session.id)
      const blockingTodos = todos.filter((todo) => Task.isBlockingStatus(todo.status)).length
      const webSearchGate = webSearchGateStatus(workflowState.kickoff)

      const status: WorkflowGateStatus = {
        id: session.id,
        title: session.title,
        mode,
        track: workflowState.kickoff?.track,
        kickoff: {
          complete: kickoffComplete,
          required: kickoffRequired,
        },
        plan: {
          mode: planMode,
          required: planRequired,
          approved: planApproved,
        },
        verify: {
          required: verifyRequired,
        },
        todos: {
          total: todos.length,
          blocking: blockingTodos,
        },
        webSearchGate,
      }

      if (args.format === "json") {
        process.stdout.write(JSON.stringify(status, null, 2) + EOL)
        return
      }

      process.stdout.write(formatStatusTable(status) + EOL)
    })
  },
})

function formatSessionTable(sessions: Session.Info[]): string {
  const lines: string[] = []

  const maxIdWidth = Math.max(20, ...sessions.map((s) => s.id.length))
  const maxTitleWidth = Math.max(25, ...sessions.map((s) => s.title.length))

  const header = `Session ID${" ".repeat(maxIdWidth - 10)}  Title${" ".repeat(maxTitleWidth - 5)}  Updated`
  lines.push(header)
  lines.push("─".repeat(header.length))
  for (const session of sessions) {
    const truncatedTitle = Locale.truncate(session.title, maxTitleWidth)
    const timeStr = Locale.todayTimeOrDateTime(session.time.updated)
    const line = `${session.id.padEnd(maxIdWidth)}  ${truncatedTitle.padEnd(maxTitleWidth)}  ${timeStr}`
    lines.push(line)
  }

  return lines.join(EOL)
}

function formatSessionJSON(sessions: Session.Info[]): string {
  const jsonData = sessions.map((session) => ({
    id: session.id,
    title: session.title,
    updated: session.time.updated,
    created: session.time.created,
    projectId: session.projectID,
    directory: session.directory,
  }))
  return JSON.stringify(jsonData, null, 2)
}

function formatStatusTable(status: WorkflowGateStatus): string {
  const lines: string[] = []
  const track = status.track ? ` • Track: ${status.track}` : ""
  lines.push(`Session: ${status.title} (${status.id})`)
  lines.push(`Mode: ${status.mode}${track}`)
  lines.push("Gates:")

  const kickoffLabel = status.kickoff.complete
    ? "complete"
    : status.kickoff.required
      ? "required"
      : "optional"
  lines.push(`- kickoff: ${kickoffLabel}`)

  let planLabel = "off"
  if (status.plan.mode !== "off") {
    planLabel = status.plan.approved ? "approved" : status.plan.required ? "required" : "optional"
  }
  lines.push(`- plan: ${planLabel}`)

  const verifyLabel = status.verify.required ? "required" : "clear"
  lines.push(`- verify: ${verifyLabel}`)

  const todosLabel =
    status.todos.blocking > 0
      ? `${status.todos.blocking} blocking (${status.todos.total} total)`
      : status.todos.total > 0
        ? `clear (${status.todos.total} total)`
        : "clear"
  lines.push(`- todos: ${todosLabel}`)

  const wsg = status.webSearchGate
  let wsgLabel = "unanswered"
  if (wsg.answered) {
    if (!wsg.required) {
      wsgLabel = "clear"
    } else {
      const missing: string[] = []
      if (wsg.missingReferences) missing.push("refs")
      if (wsg.missingVersions) missing.push("versions")
      wsgLabel = missing.length > 0 ? `required (${missing.join(", ")})` : "complete"
    }
  }
  lines.push(`- WSG: ${wsgLabel}`)

  return lines.join(EOL)
}
