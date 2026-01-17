import { Tool } from "./tool"
import DESCRIPTION from "./task.txt"
import z from "zod"
import { Session } from "../session"
import { Bus } from "../bus"
import { MessageV2 } from "../session/message-v2"
import { Identifier } from "../id/id"
import { Agent } from "../agent/agent"
import { SessionPrompt } from "../session/prompt"
import { iife } from "@/util/iife"
import { defer } from "@/util/defer"
import { Config } from "../config/config"
import { PermissionNext } from "@/permission/next"
import { TaskRun } from "@/task/run"
import { Todo } from "@/session/todo"
import { RepoTodo } from "@/task/repo"
import { TaskMetrics } from "@/task/metrics"
import { CapabilityToken } from "@/task/capability"
import { Segment } from "@/task/segment"
import { Task } from "@/task"

const parameters = z.object({
  description: z.string().describe("A short (3-5 words) description of the task"),
  prompt: z.string().describe("The task for the agent to perform"),
  subagent_type: z.string().describe("The type of specialized agent to use for this task"),
  session_id: z.string().describe("Existing Task session to continue").optional(),
  command: z.string().describe("The command that triggered this task").optional(),
  todo_id: z.string().describe("Todo id this task is executing").optional(),
  todo_lane: z.enum(["session", "repo"]).describe("Todo lane this task belongs to").optional(),
  todo_session_id: z.string().describe("Owning session id for session-lane todos").optional(),
  run_max_children: z.number().int().positive().optional(),
  run_depth: z.number().int().nonnegative().optional(),
  run_max_ops: z.number().int().positive().optional(),
  segment_id: z.string().optional(),
  segment_mode: z.enum(["autonomous", "decision"]).optional(),
})

export const TaskTool = Tool.define("task", async (ctx) => {
  const agents = await Agent.list().then((x) => x.filter((a) => a.mode !== "primary"))

  // Filter agents by permissions if agent provided
  const caller = ctx?.agent
  const accessibleAgents = caller
    ? agents.filter((a) => PermissionNext.evaluate("task", a.name, caller.permission).action !== "deny")
    : agents

  const description = DESCRIPTION.replace(
    "{agents}",
    accessibleAgents
      .map((a) => `- ${a.name}: ${a.description ?? "This subagent should only be called manually by the user."}`)
      .join("\n"),
  )
  return {
    description,
    parameters,
    async execute(params: z.infer<typeof parameters>, ctx) {
      const config = await Config.get()

      // Skip permission check when user explicitly invoked via @ or command subtask
      if (!ctx.extra?.bypassAgentCheck) {
        await ctx.ask({
          permission: "task",
          patterns: [params.subagent_type],
          always: ["*"],
          metadata: {
            description: params.description,
            subagent_type: params.subagent_type,
          },
        })
      }

      const agent = await Agent.get(params.subagent_type)
      if (!agent) throw new Error(`Unknown agent type: ${params.subagent_type} is not a valid agent type`)

      const hasTaskPermission = agent.permission.some((rule) => rule.permission === "task")

      const session = await iife(async () => {
        if (params.session_id) {
          const found = await Session.get(params.session_id).catch(() => {})
          if (found) return found
        }

        return await Session.create({
          parentID: ctx.sessionID,
          title: params.description + ` (@${agent.name} subagent)`,
          permission: [
            {
              permission: "todowrite",
              pattern: "*",
              action: "deny",
            },
            {
              permission: "todoread",
              pattern: "*",
              action: "deny",
            },
            {
              permission: "todo",
              pattern: "*",
              action: "allow",
            },
            ...(hasTaskPermission
              ? []
              : [
                  {
                    permission: "task" as const,
                    pattern: "*" as const,
                    action: "deny" as const,
                  },
                ]),
            ...(config.experimental?.primary_tools?.map((t) => ({
              pattern: "*",
              action: "allow" as const,
              permission: t,
            })) ?? []),
          ],
        })
      })
      const msg = await MessageV2.get({ sessionID: ctx.sessionID, messageID: ctx.messageID })
      if (msg.info.role !== "assistant") throw new Error("Not an assistant message")

      const todoLane = params.todo_lane ?? "session"
      const todoSessionId = params.todo_session_id ?? ctx.sessionID
      const taskrunConfig = config.task?.taskrun
      let segmentId = params.segment_id
      if (!segmentId && params.segment_mode && params.todo_id) {
        const segment = await Segment.create({
          todoId: params.todo_id,
          mode: params.segment_mode,
          budgetOverrides: {
            maxChildren: params.run_max_children ?? taskrunConfig?.max_children,
            maxDepth: params.run_depth ?? taskrunConfig?.max_depth,
            maxOps: params.run_max_ops ?? taskrunConfig?.max_ops,
          },
        })
        segmentId = segment.id
      }
      const segment = segmentId ? await Segment.get(segmentId) : undefined
      const runMaxChildren = params.run_max_children ?? segment?.budgetOverrides?.maxChildren ?? taskrunConfig?.max_children
      const runDepth = params.run_depth ?? segment?.budgetOverrides?.maxDepth ?? taskrunConfig?.max_depth
      const runMaxOps = params.run_max_ops ?? segment?.budgetOverrides?.maxOps ?? taskrunConfig?.max_ops
      const expiresAt = taskrunConfig?.token_ttl_ms
        ? new Date(Date.now() + taskrunConfig.token_ttl_ms).toISOString()
        : undefined
      const run =
        params.todo_id
          ? await TaskRun.create({
              todoId: params.todo_id,
              todoSessionId: todoLane === "session" ? todoSessionId : undefined,
              todoLane,
              sessionId: session.id,
              agentType: agent.name,
              segmentId,
              maxChildren: runMaxChildren,
              depthRemaining: runDepth,
              maxOps: runMaxOps,
            })
          : undefined
      let activeMarked = false

      async function markActive() {
        if (!run || !params.todo_id) return
        const lane = todoLane
        if (lane === "repo") {
          const current = await RepoTodo.getById({ todoId: params.todo_id, agent: ctx.agent }).catch(() => undefined)
          if (!current) return
          const status = Task.normalizeStatus(current.status)
          if (status === "in_progress" || Task.isDoneStatus(status)) return
          await RepoTodo.updateOne({
            sessionID: ctx.sessionID,
            todoId: params.todo_id,
            agent: ctx.agent,
            patch: { status: "in_progress" },
            expectedVersion: current.version ?? 0,
            expected: { status: current.status },
            runId: run.id,
            internal: true,
          }).catch(() => {})
        } else {
          const current = await Todo.getById({ sessionID: todoSessionId, todoId: params.todo_id }).catch(() => undefined)
          if (!current) return
          const status = Task.normalizeStatus(current.status)
          if (status === "in_progress" || Task.isDoneStatus(status)) return
          await Todo.updateOne({
            sessionID: todoSessionId,
            todoId: params.todo_id,
            patch: { status: "in_progress" },
            expectedVersion: current.version ?? 0,
            expected: { status: current.status },
            runId: run.id,
            internal: true,
          }).catch(() => {})
        }
        await Todo.recordActive({
          sessionID: todoSessionId,
          todoId: params.todo_id,
          lane,
          runId: run.id,
        }).catch(() => {})
        activeMarked = true
      }

      async function clearActive(resetStatus: boolean) {
        if (!run || !params.todo_id) return
        if (activeMarked) {
          await Todo.clearActive({ sessionID: todoSessionId, todoId: params.todo_id }).catch(() => {})
        }
        if (!resetStatus) return
        const lane = todoLane
        if (lane === "repo") {
          const current = await RepoTodo.getById({ todoId: params.todo_id, agent: ctx.agent }).catch(() => undefined)
          if (!current) return
          const status = Task.normalizeStatus(current.status)
          if (status !== "in_progress") return
          await RepoTodo.updateOne({
            sessionID: ctx.sessionID,
            todoId: params.todo_id,
            agent: ctx.agent,
            patch: { status: "open" },
            expectedVersion: current.version ?? 0,
            expected: { status: current.status },
            runId: run.id,
            internal: true,
          }).catch(() => {})
        } else {
          const current = await Todo.getById({ sessionID: todoSessionId, todoId: params.todo_id }).catch(() => undefined)
          if (!current) return
          const status = Task.normalizeStatus(current.status)
          if (status !== "in_progress") return
          await Todo.updateOne({
            sessionID: todoSessionId,
            todoId: params.todo_id,
            patch: { status: "open" },
            expectedVersion: current.version ?? 0,
            expected: { status: current.status },
            runId: run.id,
            internal: true,
          }).catch(() => {})
        }
      }

      if (run) {
        const token = await CapabilityToken.create({
          runId: run.id,
          scope: {
            rootTodoId: run.todoId,
            allowChildren: true,
            allowParentRead: true,
            allowDepsRead: true,
          },
          depthRemaining: run.counters.depthRemaining,
          expiresAt,
        })
        await TaskRun.attachCapability(run.id, token.id)
        if (segmentId) {
          await TaskRun.attachSegment(run.id, segmentId)
          await Segment.addRun(segmentId, run.id).catch(() => {})
          await Segment.start(segmentId).catch(() => {})
        }
        await TaskRun.start(run.id)
        await markActive()
      }

      ctx.metadata({
        title: params.description,
        metadata: {
          sessionId: session.id,
          runId: run?.id,
          todoId: params.todo_id,
          todoLane,
          segmentId: segmentId,
        },
      })

      const messageID = Identifier.ascending("message")
      const parts: Record<string, { id: string; tool: string; state: { status: string; title?: string } }> = {}
      const unsub = Bus.subscribe(MessageV2.Event.PartUpdated, async (evt) => {
        if (evt.properties.part.sessionID !== session.id) return
        if (evt.properties.part.messageID === messageID) return
        if (evt.properties.part.type !== "tool") return
        const part = evt.properties.part
        parts[part.id] = {
          id: part.id,
          tool: part.tool,
          state: {
            status: part.state.status,
            title: part.state.status === "completed" ? part.state.title : undefined,
          },
        }
        ctx.metadata({
          title: params.description,
          metadata: {
            summary: Object.values(parts).sort((a, b) => a.id.localeCompare(b.id)),
            sessionId: session.id,
            runId: run?.id,
            todoId: params.todo_id,
            todoLane,
            segmentId: segmentId,
          },
        })
      })

      const model = agent.model ?? {
        modelID: msg.info.modelID,
        providerID: msg.info.providerID,
      }

      function cancel() {
        SessionPrompt.cancel(session.id)
      }
      ctx.abort.addEventListener("abort", cancel)
      using _ = defer(() => ctx.abort.removeEventListener("abort", cancel))
      const promptParts = await SessionPrompt.resolvePromptParts(params.prompt)

      let result: Awaited<ReturnType<typeof SessionPrompt.prompt>>
      try {
        result = await SessionPrompt.prompt({
          messageID,
          sessionID: session.id,
          model: {
            modelID: model.modelID,
            providerID: model.providerID,
          },
          agent: agent.name,
          tools: {
            todowrite: false,
            todoread: false,
            ...(hasTaskPermission ? {} : { task: false }),
            ...Object.fromEntries((config.experimental?.primary_tools ?? []).map((t) => [t, false])),
          },
          parts: promptParts,
        })
      } catch (error) {
        unsub()
        await clearActive(true).catch(() => {})
        if (run) {
          const message = error instanceof Error ? error.message : String(error)
          const status = error instanceof TaskRun.BudgetExceededError ? "budget_exhausted" : undefined
          await TaskRun.fail(run.id, {
            error: message,
            cancelled: ctx.abort.aborted,
            status,
            cleanupMode: taskrunConfig?.cleanup_mode,
          }).catch(() => {})
          if (params.todo_id) {
            await TaskMetrics.update(params.todo_id).catch(() => {})
          }
          // Cleanup handled by TaskRun.fail -> cleanupDraftChildren
          if (segmentId && status) {
            await Segment.fail(segmentId).catch(() => {})
          }
        }
        throw error
      }
      unsub()
      const messages = await Session.messages({ sessionID: session.id })
      const summary = messages
        .filter((x) => x.info.role === "assistant")
        .flatMap((msg) => msg.parts.filter((x: any) => x.type === "tool") as MessageV2.ToolPart[])
        .map((part) => ({
          id: part.id,
          tool: part.tool,
          state: {
            status: part.state.status,
            title: part.state.status === "completed" ? part.state.title : undefined,
          },
        }))
      const text = result.parts.findLast((x) => x.type === "text")?.text ?? ""
      if (run) {
        await TaskRun.complete(run.id, { summary: text, cleanupMode: taskrunConfig?.cleanup_mode }).catch(() => {})
        if (segmentId) {
          await Segment.complete(segmentId).catch(() => {})
        }
        if (params.todo_id) {
          await TaskMetrics.update(params.todo_id).catch(() => {})
        }
        await clearActive(true).catch(() => {})
        // Promotion handled by TaskRun.complete -> cleanupDraftChildren
      }

      const output =
        text +
        "\n\n" +
        [
          "<task_metadata>",
          `session_id: ${session.id}`,
          run ? `run_id: ${run.id}` : null,
          segmentId ? `segment_id: ${segmentId}` : null,
          "</task_metadata>",
        ]
          .filter(Boolean)
          .join("\n")

      return {
        title: params.description,
        metadata: {
          summary,
          sessionId: session.id,
          runId: run?.id,
          segmentId: segmentId,
        },
        output,
      }
    },
  }
})
