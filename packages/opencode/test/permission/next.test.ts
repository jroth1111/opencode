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

test("merge - wildcard wipes specific patterns", () => {
  const result = PermissionNext.merge({ bash: { foo: "ask", bar: "allow" } }, { bash: { "*": "deny" } })
  expect(result).toEqual({ bash: { "*": "deny" } })
})

test("merge - specific pattern after wildcard", () => {
  const result = PermissionNext.merge({ bash: { "*": "deny" } }, { bash: { foo: "allow" } })
  expect(result).toEqual({ bash: { "*": "deny", foo: "allow" } })
})

test("merge - glob pattern wipes matching patterns", () => {
  const result = PermissionNext.merge(
    { bash: { "foo/bar": "ask", "foo/baz": "allow", other: "deny" } },
    { bash: { "foo/*": "deny" } },
  )
  expect(result).toEqual({ bash: { "foo/*": "deny", other: "deny" } })
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

test("merge - nested glob patterns", () => {
  const result = PermissionNext.merge(
    { edit: { "src/components/Button.tsx": "allow", "src/components/Input.tsx": "allow" } },
    { edit: { "src/components/*": "deny" } },
  )
  expect(result).toEqual({ edit: { "src/components/*": "deny" } })
})

test("merge - non-matching glob preserves existing", () => {
  const result = PermissionNext.merge({ edit: { "src/foo.ts": "allow" } }, { edit: { "test/*": "deny" } })
  expect(result).toEqual({ edit: { "src/foo.ts": "allow", "test/*": "deny" } })
})
