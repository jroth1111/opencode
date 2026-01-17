import { describe, expect, test } from "bun:test"
import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"
import { TaskRun } from "../../src/task/run"
import { CapabilityToken } from "../../src/task/capability"
import { RepoTodo } from "../../src/task/repo"
import { Task } from "../../src/task"

describe("taskrun budgets", () => {
  test("enforces maxChildren, maxDepth, maxOps", async () => {
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
        await RepoTodo.upsert({ sessionID: "s1", agent: "build", todos: [root] })

        const run = await TaskRun.create({
          todoId: "root",
          sessionId: "s-run",
          agentType: "agent",
          maxChildren: 1,
          depthRemaining: 2,
          maxOps: 2,
        })
        const token = await CapabilityToken.create({
          runId: run.id,
          scope: {
            rootTodoId: "root",
            allowChildren: true,
            allowParentRead: true,
            allowDepsRead: true,
          },
          depthRemaining: run.counters.depthRemaining,
        })
        await TaskRun.attachCapability(run.id, token.id)
        await TaskRun.start(run.id)

        await RepoTodo.createChild({
          sessionID: "s-run",
          parentId: "root",
          agent: "agent",
          runId: run.id,
          task: Task.normalize({
            id: "child1",
            content: "child 1",
            status: "draft",
            priority: 2,
            lane: "repo",
          }),
        })

        await expect(
          RepoTodo.createChild({
            sessionID: "s-run",
            parentId: "root",
            agent: "agent",
            runId: run.id,
            task: Task.normalize({
              id: "child2",
              content: "child 2",
              status: "draft",
              priority: 2,
              lane: "repo",
            }),
          }),
        ).rejects.toThrow("maxChildren")

        await TaskRun.consumeDepth(run.id)
        await expect(TaskRun.consumeDepth(run.id)).rejects.toThrow("depthRemaining")

        const refreshed = await TaskRun.get(run.id)
        const remainingOps = refreshed ? refreshed.budgets.maxOps - refreshed.counters.opsUsed : 0
        for (let i = 0; i < remainingOps; i++) {
          await TaskRun.consumeOps(run.id)
        }
        await expect(TaskRun.consumeOps(run.id)).rejects.toThrow("maxOps")
      },
    })
  })
})
