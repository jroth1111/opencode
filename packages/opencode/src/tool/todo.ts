import z from "zod"
import { Tool } from "./tool"
import DESCRIPTION_WRITE from "./todowrite.txt"
import { Todo } from "../session/todo"
import { Task } from "@/task"
import { RepoTodo } from "@/task/repo"

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

    if (sessionTodos.length > 0) {
      await Todo.update({
        sessionID: ctx.sessionID,
        agent: ctx.agent,
        todos: sessionTodos,
        tool: {
          messageID: ctx.messageID,
          callID: ctx.callID,
        },
      })
    }

    if (repoTodos.length > 0) {
      await RepoTodo.upsert({
        sessionID: ctx.sessionID,
        agent: ctx.agent,
        todos: repoTodos,
      })
    }

    const sessionBlocking = sessionTodos.filter((x) => Task.isBlockingStatus(x.status)).length
    const title =
      repoTodos.length > 0 ? `${sessionBlocking} session todos, ${repoTodos.length} repo todos` : `${sessionBlocking} todos`
    return {
      title,
      output: JSON.stringify(params.todos, null, 2),
      metadata: {
        todos: params.todos,
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
