import { describe, expect, test } from "bun:test"
import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"
import { CapabilityToken } from "../../src/task/capability"

describe("capability tokens", () => {
  test("create, verify, revoke, expire", async () => {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const token = await CapabilityToken.create({
          runId: "run_1",
          scope: {
            rootTodoId: "todo_1",
            allowChildren: true,
            allowParentRead: true,
            allowDepsRead: true,
          },
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        })

        await expect(CapabilityToken.assertValid(token)).resolves.toBeUndefined()

        const revoked = await CapabilityToken.revoke(token.id)
        expect(revoked?.revokedAt).toBeDefined()
        await expect(CapabilityToken.assertValid(revoked!)).rejects.toThrow("revoked")

        const expired = await CapabilityToken.create({
          runId: "run_2",
          scope: {
            rootTodoId: "todo_2",
            allowChildren: true,
            allowParentRead: true,
            allowDepsRead: true,
          },
          expiresAt: new Date(Date.now() - 60_000).toISOString(),
        })
        await expect(CapabilityToken.assertValid(expired)).rejects.toThrow("expired")
      },
    })
  })
})
