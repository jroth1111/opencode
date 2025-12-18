import { describe, expect, test } from "bun:test"
import { ToolRegistry } from "../../src/tool/registry"
import type { Agent } from "../../src/agent/agent"

describe("ToolRegistry.enabled", () => {
  test("returns empty object when all tools allowed", async () => {
    const agent: Agent.Info = {
      name: "test",
      mode: "primary",
      permission: {
        edit: { "*": "allow" },
        bash: { "*": "allow" },
      },
      options: {},
    }
    const result = await ToolRegistry.enabled(agent)
    expect(result).toEqual({})
  })

  test("disables edit tools when edit is denied", async () => {
    const agent: Agent.Info = {
      name: "test",
      mode: "primary",
      permission: {
        edit: { "*": "deny" },
        bash: { "*": "allow" },
      },
      options: {},
    }
    const result = await ToolRegistry.enabled(agent)
    expect(result.edit).toBe(false)
    expect(result.write).toBe(false)
    expect(result.patch).toBe(false)
    expect(result.multiedit).toBe(false)
  })

  test("disables specific tool when denied with wildcard", async () => {
    const agent: Agent.Info = {
      name: "test",
      mode: "primary",
      permission: {
        bash: { "*": "deny" },
        edit: { "*": "allow" },
      },
      options: {},
    }
    const result = await ToolRegistry.enabled(agent)
    expect(result.bash).toBe(false)
  })

  test("does not disable tool when partially denied", async () => {
    const agent: Agent.Info = {
      name: "test",
      mode: "primary",
      permission: {
        bash: {
          "rm *": "deny",
          "*": "allow",
        },
        edit: { "*": "allow" },
      },
      options: {},
    }
    const result = await ToolRegistry.enabled(agent)
    expect(result.bash).toBeUndefined()
  })

  test("disables multiple tools when multiple denied", async () => {
    const agent: Agent.Info = {
      name: "test",
      mode: "primary",
      permission: {
        edit: { "*": "deny" },
        bash: { "*": "deny" },
        webfetch: { "*": "deny" },
      },
      options: {},
    }
    const result = await ToolRegistry.enabled(agent)
    expect(result.edit).toBe(false)
    expect(result.write).toBe(false)
    expect(result.patch).toBe(false)
    expect(result.multiedit).toBe(false)
    expect(result.bash).toBe(false)
    expect(result.webfetch).toBe(false)
  })

  test("does not disable tool when action is ask", async () => {
    const agent: Agent.Info = {
      name: "test",
      mode: "primary",
      permission: {
        edit: { "*": "ask" },
        bash: { "*": "ask" },
      },
      options: {},
    }
    const result = await ToolRegistry.enabled(agent)
    expect(result.edit).toBeUndefined()
    expect(result.bash).toBeUndefined()
  })

  test("does not disable tool when wildcard deny has additional allow rules", async () => {
    const agent: Agent.Info = {
      name: "test",
      mode: "primary",
      permission: {
        bash: {
          "*": "deny",
          "echo *": "allow",
        },
        edit: { "*": "allow" },
      },
      options: {},
    }
    const result = await ToolRegistry.enabled(agent)
    // bash should NOT be disabled because there's an allow rule for "echo *"
    expect(result.bash).toBeUndefined()
  })
})
