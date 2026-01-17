import { describe, expect, test } from "bun:test"
import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"
import { RepoTodo } from "../../src/task/repo"
import { TaskRun } from "../../src/task/run"
import { Task } from "../../src/task"
import { CapabilityToken } from "../../src/task/capability"

describe("todo optimistic merge (repo tracker json)", () => {
  test("strict merge succeeds on version mismatch when fields do not overlap", async () => {
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
        const baseTodo = Task.normalize({
          id: "t1",
          content: "first task",
          status: "open",
          priority: 2,
          lane: "repo",
          files: ["README.md"],
          action: "do the thing",
          verify: "check output",
          done: "complete",
        })
        await RepoTodo.upsert({ sessionID: "s1", agent: "build", todos: [baseTodo] })

        const run = await TaskRun.create({ todoId: "t1", sessionId: "s-run", agentType: "agent" })
        const token = await CapabilityToken.create({
          runId: run.id,
          scope: {
            rootTodoId: "t1",
            allowChildren: true,
            allowParentRead: true,
            allowDepsRead: true,
          },
        })
        await TaskRun.attachCapability(run.id, token.id)
        await TaskRun.start(run.id)

        const updated1 = await RepoTodo.updateOne({
          sessionID: "s-run",
          todoId: "t1",
          agent: "agent",
          patch: { status: "in_progress" },
          expectedVersion: 0,
          expected: { status: "open" },
          runId: run.id,
        })
        expect(Task.normalizeStatus(updated1.status)).toBe("in_progress")
        expect(updated1.version).toBe(1)

        const { version: _omit, ...external } = updated1
        await RepoTodo.upsert({
          sessionID: "s1",
          agent: "build",
          todos: [Task.normalize({ ...external, content: "updated title" })],
        })

        const updated2 = await RepoTodo.updateOne({
          sessionID: "s-run",
          todoId: "t1",
          agent: "agent",
          patch: { status: "closed" },
          expectedVersion: 1,
          expected: { status: "in_progress" },
          runId: run.id,
        })
        expect(Task.normalizeStatus(updated2.status)).toBe("closed")
        expect(updated2.version).toBe(3)
      },
    })
  })

  test("rejects on mismatch when expected is provided", async () => {
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
        const baseTodo = Task.normalize({
          id: "t2",
          content: "second task",
          status: "open",
          priority: 2,
          lane: "repo",
          files: ["README.md"],
          action: "do the thing",
          verify: "check output",
          done: "complete",
        })
        await RepoTodo.upsert({ sessionID: "s1", agent: "build", todos: [baseTodo] })

        const run = await TaskRun.create({ todoId: "t2", sessionId: "s-run", agentType: "agent" })
        const token = await CapabilityToken.create({
          runId: run.id,
          scope: {
            rootTodoId: "t2",
            allowChildren: true,
            allowParentRead: true,
            allowDepsRead: true,
          },
        })
        await TaskRun.attachCapability(run.id, token.id)
        await TaskRun.start(run.id)

        const updated1 = await RepoTodo.updateOne({
          sessionID: "s-run",
          todoId: "t2",
          agent: "agent",
          patch: { status: "in_progress" },
          expectedVersion: 0,
          expected: { status: "open" },
          runId: run.id,
        })

        const { version: _omit, ...external } = updated1
        await RepoTodo.upsert({
          sessionID: "s1",
          agent: "build",
          todos: [Task.normalize({ ...external, status: "blocked" })],
        })

        await expect(
          RepoTodo.updateOne({
            sessionID: "s-run",
            todoId: "t2",
            agent: "agent",
            patch: { status: "closed" },
            expectedVersion: 1,
            expected: { status: "in_progress" },
            runId: run.id,
          }),
        ).rejects.toThrow("version mismatch")
      },
    })
  })
})
