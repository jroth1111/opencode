import { describe, expect, test } from "bun:test"
import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"
import { RepoTodo } from "../../src/task/repo"
import { TaskRun } from "../../src/task/run"
import { Task } from "../../src/task"
import { CapabilityToken } from "../../src/task/capability"

describe("todo graph (repo tracker json)", () => {
  test("returns bounded child graph for scoped run", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: {
        task: {
          repo_tracker: "json",
        },
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const root = Task.normalize({
          id: "root",
          content: "root task",
          status: "open",
          priority: 2,
          lane: "repo",
        })
        const child = Task.normalize({
          id: "child",
          content: "child task",
          status: "open",
          priority: 2,
          lane: "repo",
          parentId: "root",
        })
        await RepoTodo.upsert({ sessionID: "s1", agent: "build", todos: [root, child] })

        const run = await TaskRun.create({ todoId: "root", sessionId: "s-run", agentType: "agent" })
        const token = await CapabilityToken.create({
          runId: run.id,
          scope: {
            rootTodoId: "root",
            allowChildren: true,
            allowParentRead: true,
            allowDepsRead: true,
          },
        })
        await TaskRun.attachCapability(run.id, token.id)
        await TaskRun.start(run.id)

        const graph = await RepoTodo.graph({
          sessionID: "s-run",
          rootId: "root",
          agent: "agent",
          runId: run.id,
          depth: 1,
          limit: 10,
          include: { children: true, parent: false, deps: false },
        })

        expect(graph.root.id).toBe("root")
        expect(graph.nodes.some((node) => node.id === "child")).toBe(true)
        expect(graph.edges?.some((edge) => edge.type === "child" && edge.from === "root" && edge.to === "child")).toBe(
          true,
        )
      },
    })
  })
})
