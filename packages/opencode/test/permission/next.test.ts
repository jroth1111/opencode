import { test, expect } from "bun:test"
import { PermissionNext } from "../../src/permission/next"

// fromConfig tests

test("fromConfig - string value becomes wildcard", () => {
  const result = PermissionNext.fromConfig({ bash: "allow" })
  expect(result).toEqual({ bash: { "*": "allow" } })
})

test("fromConfig - object value stays as-is", () => {
  const result = PermissionNext.fromConfig({ bash: { "*": "allow", rm: "deny" } })
  expect(result).toEqual({ bash: { "*": "allow", rm: "deny" } })
})

test("fromConfig - mixed string and object values", () => {
  const result = PermissionNext.fromConfig({
    bash: { "*": "allow", rm: "deny" },
    edit: "allow",
    webfetch: "ask",
  })
  expect(result).toEqual({
    bash: { "*": "allow", rm: "deny" },
    edit: { "*": "allow" },
    webfetch: { "*": "ask" },
  })
})

test("fromConfig - empty object", () => {
  const result = PermissionNext.fromConfig({})
  expect(result).toEqual({})
})

// merge tests

test("merge - simple override", () => {
  const result = PermissionNext.merge({ bash: { "*": "allow" } }, { bash: { "*": "deny" } })
  expect(result).toEqual({ bash: { "*": "deny" } })
})

test("merge - adds new permission", () => {
  const result = PermissionNext.merge({ bash: { "*": "allow" } }, { edit: { "*": "deny" } })
  expect(result).toEqual({
    bash: { "*": "allow" },
    edit: { "*": "deny" },
  })
})

test("merge - wildcard overwrites specific patterns", () => {
  const result = PermissionNext.merge({ bash: { foo: "ask", bar: "allow" } }, { bash: { "*": "deny" } })
  expect(result).toEqual({ bash: { foo: "deny", bar: "deny", "*": "deny" } })
})

test("merge - specific pattern after wildcard", () => {
  const result = PermissionNext.merge({ bash: { "*": "deny" } }, { bash: { foo: "allow" } })
  expect(result).toEqual({ bash: { "*": "deny", foo: "allow" } })
})

test("merge - glob pattern overwrites matching patterns", () => {
  const result = PermissionNext.merge(
    { bash: { "foo/bar": "ask", "foo/baz": "allow", other: "deny" } },
    { bash: { "foo/*": "deny" } },
  )
  expect(result).toEqual({ bash: { "foo/bar": "deny", "foo/baz": "deny", other: "deny", "foo/*": "deny" } })
})

test("merge - multiple rulesets", () => {
  const result = PermissionNext.merge({ bash: { "*": "allow" } }, { bash: { rm: "ask" } }, { edit: { "*": "allow" } })
  expect(result).toEqual({
    bash: { "*": "allow", rm: "ask" },
    edit: { "*": "allow" },
  })
})

test("merge - empty ruleset does nothing", () => {
  const result = PermissionNext.merge({ bash: { "*": "allow" } }, {})
  expect(result).toEqual({ bash: { "*": "allow" } })
})

test("merge - nested glob patterns overwrites matching", () => {
  const result = PermissionNext.merge(
    { edit: { "src/components/Button.tsx": "allow", "src/components/Input.tsx": "allow" } },
    { edit: { "src/components/*": "deny" } },
  )
  expect(result).toEqual({
    edit: { "src/components/Button.tsx": "deny", "src/components/Input.tsx": "deny", "src/components/*": "deny" },
  })
})

test("merge - non-matching glob preserves existing", () => {
  const result = PermissionNext.merge({ edit: { "src/foo.ts": "allow" } }, { edit: { "test/*": "deny" } })
  expect(result).toEqual({ edit: { "src/foo.ts": "allow", "test/*": "deny" } })
})

test("merge - wildcard permission overwrites all other permissions", () => {
  const result = PermissionNext.merge(
    { bash: { "/bin/ls": "allow" }, edit: { "src/*": "allow" } },
    { "*": { "*": "ask" } },
  )
  // The wildcard permission should overwrite existing permissions' values
  expect(result).toEqual({
    bash: { "/bin/ls": "ask" },
    edit: { "src/*": "ask" },
    "*": { "*": "ask" },
  })
})

// evaluate tests

test("evaluate - exact permission and pattern match", () => {
  const result = PermissionNext.evaluate("bash", "rm", { bash: { rm: "deny" } })
  expect(result).toBe("deny")
})

test("evaluate - wildcard pattern match", () => {
  const result = PermissionNext.evaluate("bash", "rm", { bash: { "*": "allow" } })
  expect(result).toBe("allow")
})

test("evaluate - specific pattern takes precedence over wildcard", () => {
  const result = PermissionNext.evaluate("bash", "rm", { bash: { "*": "allow", rm: "deny" } })
  expect(result).toBe("deny")
})

test("evaluate - glob pattern match", () => {
  const result = PermissionNext.evaluate("edit", "src/foo.ts", { edit: { "src/*": "allow" } })
  expect(result).toBe("allow")
})

test("evaluate - more specific glob takes precedence", () => {
  const result = PermissionNext.evaluate("edit", "src/components/Button.tsx", {
    edit: { "src/*": "deny", "src/components/*": "allow" },
  })
  expect(result).toBe("allow")
})

test("evaluate - wildcard permission match", () => {
  const result = PermissionNext.evaluate("bash", "rm", { "*": { "*": "deny" } })
  expect(result).toBe("deny")
})

test("evaluate - specific permission takes precedence over wildcard permission", () => {
  const result = PermissionNext.evaluate("bash", "rm", {
    "*": { "*": "deny" },
    bash: { "*": "allow" },
  })
  expect(result).toBe("allow")
})

test("evaluate - unknown permission with wildcard fallback", () => {
  const result = PermissionNext.evaluate("unknown_tool", "anything", { "*": { "*": "ask" } })
  expect(result).toBe("ask")
})

test("evaluate - unknown permission without wildcard returns ask", () => {
  const result = PermissionNext.evaluate("unknown_tool", "anything", { bash: { "*": "allow" } })
  expect(result).toBe("ask")
})

test("evaluate - empty ruleset returns ask", () => {
  const result = PermissionNext.evaluate("bash", "rm", {})
  expect(result).toBe("ask")
})

test("evaluate - no matching pattern returns ask", () => {
  const result = PermissionNext.evaluate("edit", "etc/passwd", { edit: { "src/*": "allow" } })
  expect(result).toBe("ask")
})

test("evaluate - glob permission pattern", () => {
  const result = PermissionNext.evaluate("mcp_server_tool", "anything", {
    "mcp_*": { "*": "allow" },
  })
  expect(result).toBe("allow")
})

test("evaluate - specific permission over glob permission", () => {
  const result = PermissionNext.evaluate("mcp_dangerous", "anything", {
    "mcp_*": { "*": "allow" },
    mcp_dangerous: { "*": "deny" },
  })
  expect(result).toBe("deny")
})

test("evaluate - combined permission and pattern specificity", () => {
  const result = PermissionNext.evaluate("edit", "src/secret.ts", {
    "*": { "*": "ask" },
    edit: { "*": "allow", "src/secret.ts": "deny" },
  })
  expect(result).toBe("deny")
})
