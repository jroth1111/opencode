import z from "zod"
import { Tool } from "./tool"
import DESCRIPTION_WRITE from "./todowrite.txt"
import { Todo } from "../session/todo"
import { Task } from "@/task"
import { RepoTodo } from "@/task/repo"
import { TaskRun } from "@/task/run"
import { Identifier } from "@/id/id"
import { randomUUID } from "crypto"

export const TodoWriteTool = Tool.define("todowrite", {
  description: DESCRIPTION_WRITE,
  parameters: z.object({
    todos: z.array(z.object(Task.Info.shape)).describe("The updated task list"),
  }),
  async execute(params, ctx) {
    await ctx.ask({
      permission: "todowrite",
      patterns: ["*"],
      always: ["*"],
      metadata: {},
    })

    const sessionTodos = params.todos.filter((todo) => (todo.lane ?? "session") !== "repo")
    const repoTodos = params.todos.filter((todo) => (todo.lane ?? "session") === "repo")

    let updatedSessionTodos: Task.Info[] | undefined
    if (sessionTodos.length > 0) {
      updatedSessionTodos = await Todo.update({
        sessionID: ctx.sessionID,
        agent: ctx.agent,
        todos: sessionTodos,
        tool: {
          messageID: ctx.messageID,
          callID: ctx.callID,
        },
      })
    }

    let updatedRepoTodos: Task.Info[] | undefined
    if (repoTodos.length > 0) {
      updatedRepoTodos = await RepoTodo.upsert({
        sessionID: ctx.sessionID,
        agent: ctx.agent,
        todos: repoTodos,
        tool: {
          messageID: ctx.messageID,
          callID: ctx.callID,
        },
      })
    }

    const mergedTodos = [...(updatedSessionTodos ?? sessionTodos), ...(updatedRepoTodos ?? repoTodos)]
    const sessionBlocking = (updatedSessionTodos ?? sessionTodos).filter((x) => Task.isBlockingStatus(x.status))
      .length
    const title =
      repoTodos.length > 0 ? `${sessionBlocking} session todos, ${repoTodos.length} repo todos` : `${sessionBlocking} todos`
    return {
      title,
      output: JSON.stringify(mergedTodos, null, 2),
      metadata: {
        todos: mergedTodos,
      },
    }
  },
})

export const TodoReadTool = Tool.define("todoread", {
  description: "Use this tool to read your todo list",
  parameters: z.object({
    lane: z.enum(["session", "repo", "ready"]).optional().describe("Which task lane to read"),
    agent: z.string().optional().describe("Agent lane to filter repo tasks"),
  }),
  async execute(_params, ctx) {
    await ctx.ask({
      permission: "todoread",
      patterns: ["*"],
      always: ["*"],
      metadata: {},
    })

    const lane = _params.lane ?? "session"
    const agent = _params.agent ?? ctx.agent
    const todos =
      lane === "repo"
        ? await RepoTodo.list({ agent })
        : lane === "ready"
          ? await RepoTodo.ready({ agent })
          : await Todo.get(ctx.sessionID)
    return {
      title: `${todos.filter((x) => Task.isBlockingStatus(x.status)).length} todos`,
      metadata: {
        todos,
      },
      output: JSON.stringify(todos, null, 2),
    }
  },
})

const TodoPatchSchema = z.object({
  status: Task.Status.optional(),
  blocks: z.array(z.string()).optional(),
  dependsOn: z.array(z.string()).optional(),
  action: z.string().optional(),
  verify: z.string().optional(),
  done: z.string().optional(),
})

type TodoPatch = z.infer<typeof TodoPatchSchema>

const ChildTaskSchema = z.object({
  id: z.string().optional(),
  content: z.string(),
  status: Task.Status.optional(),
  priority: Task.Priority.optional(),
  files: z.array(z.string()).optional(),
  action: z.string().optional(),
  verify: z.string().optional(),
  done: z.string().optional(),
  issueType: z.string().optional(),
  tracker: Task.Tracker.optional(),
  dependsOn: z.array(z.string()).optional(),
  blocks: z.array(z.string()).optional(),
  parentId: z.string().optional(),
  assignee: z.string().optional(),
  estimateMinutes: z.number().int().positive().optional(),
})

const ExpectedPatchSchema = TodoPatchSchema.partial()

type TodoToolMetadata = {
  todo?: Task.Info
  todos?: Task.Info[]
  graph?: Task.Graph
}

const TodoToolParams = z.object({
  action: z.enum(["get", "update", "create_child", "list_children", "graph"]),
  lane: z.enum(["session", "repo"]).optional(),
  id: z.string().optional(),
  parent_id: z.string().optional(),
  patch: TodoPatchSchema.optional(),
  expected_version: z
    .number()
    .int()
    .optional()
    .describe("Last seen version for strict conflict checks."),
  expected: ExpectedPatchSchema.optional().describe("Expected field values for strict conflict checks."),
  task: ChildTaskSchema.optional(),
  limit: z.number().int().nonnegative().optional(),
  depth: z.number().int().nonnegative().optional(),
  include: z
    .object({
      parent: z.boolean().optional(),
      deps: z.boolean().optional(),
      children: z.boolean().optional(),
    })
    .optional(),
})

export const TodoTool = Tool.define<typeof TodoToolParams, TodoToolMetadata>("todo", {
  description:
    "Scoped todo operations for subagents (single-item get/update/create/list/graph) with strict conflict checks.",
  parameters: TodoToolParams,
  async execute(params, ctx) {
    await ctx.ask({
      permission: "todo",
      patterns: ["*"],
      always: ["*"],
      metadata: { action: params.action },
    })

    const run = await TaskRun.getActiveBySession(ctx.sessionID)
    if (!run) throw new Error("No active TaskRun for this session")
    if (run.todoLane && params.lane && params.lane !== run.todoLane) {
      throw new Error(`Lane mismatch: TaskRun is ${run.todoLane}`)
    }
    const lane = params.lane ?? run.todoLane ?? "session"
    const targetSessionId = lane === "session" ? run.todoSessionId ?? ctx.sessionID : ctx.sessionID

    switch (params.action) {
      case "get": {
        const id = params.id
        if (!id) throw new Error("id is required for get")
        const todo =
          lane === "repo"
            ? await RepoTodo.getOne({ sessionID: ctx.sessionID, todoId: id, agent: ctx.agent, runId: run.id })
            : await Todo.getOne({ sessionID: targetSessionId, todoId: id, runId: run.id })
        return {
          title: `Todo ${id}`,
          output: JSON.stringify(todo, null, 2),
          metadata: { todo },
        }
      }
      case "update": {
        const id = params.id
        if (!id) throw new Error("id is required for update")
        if (!params.patch) throw new Error("patch is required for update")
        const observed = run.observed?.[id]
        const expectedVersion = params.expected_version ?? observed?.version
        const expected = params.expected ?? (observed?.snapshot as Partial<TodoPatch> | undefined)
        if (expectedVersion === undefined) throw new Error("expected_version is required for update")
        if (!expected) throw new Error("expected is required for update")
        const updated =
          lane === "repo"
            ? await RepoTodo.updateOne({
                sessionID: ctx.sessionID,
                todoId: id,
                agent: ctx.agent,
                patch: params.patch,
                expectedVersion,
                expected,
                runId: run.id,
              })
            : await Todo.updateOne({
                sessionID: targetSessionId,
                todoId: id,
                patch: params.patch,
                expectedVersion,
                expected,
                runId: run.id,
              })
        return {
          title: `Todo ${id} updated`,
          output: JSON.stringify(updated, null, 2),
          metadata: { todo: updated },
        }
      }
      case "create_child": {
        const parentId = params.parent_id
        if (!parentId) throw new Error("parent_id is required for create_child")
        const task = params.task
        if (!task) throw new Error("task is required for create_child")
        const id = task.id ?? `${Identifier.ascending("run")}-${randomUUID()}`
        const child = Task.normalize({
          ...task,
          id,
          parentId,
          lane,
          status: task.status ?? "draft",
          priority: task.priority ?? 2,
        })
        const created =
          lane === "repo"
            ? await RepoTodo.createChild({
                sessionID: ctx.sessionID,
                parentId,
                task: child,
                agent: ctx.agent,
                runId: run.id,
              })
            : await Todo.createChild({
                sessionID: targetSessionId,
                parentId,
                task: child,
                runId: run.id,
              })
        return {
          title: `Child todo created`,
          output: JSON.stringify(created, null, 2),
          metadata: { todo: created },
        }
      }
      case "list_children": {
        const parentId = params.parent_id
        if (!parentId) throw new Error("parent_id is required for list_children")
        const limit = params.limit ?? run.budgets.maxChildren
        const children =
          lane === "repo"
            ? await RepoTodo.listChildren({ sessionID: ctx.sessionID, parentId, agent: ctx.agent, runId: run.id, limit })
            : await Todo.listChildren({ sessionID: targetSessionId, parentId, runId: run.id, limit })
        return {
          title: `Children for ${parentId}`,
          output: JSON.stringify(children, null, 2),
          metadata: { todos: children },
        }
      }
      case "graph": {
        const id = params.id
        if (!id) throw new Error("id is required for graph")
        const graph =
          lane === "repo"
            ? await RepoTodo.graph({
                sessionID: ctx.sessionID,
                rootId: id,
                agent: ctx.agent,
                runId: run.id,
                depth: params.depth,
                limit: params.limit,
                include: params.include,
              })
            : await Todo.graph({
                sessionID: targetSessionId,
                rootId: id,
                runId: run.id,
                depth: params.depth,
                limit: params.limit,
                include: params.include,
              })
        return {
          title: `Todo graph ${id}`,
          output: JSON.stringify(graph, null, 2),
          metadata: { graph },
        }
      }
    }
  },
})
