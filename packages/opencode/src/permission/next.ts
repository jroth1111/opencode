import { Bus } from "@/bus"
import { BusEvent } from "@/bus/bus-event"
import { Config } from "@/config/config"
import { Identifier } from "@/id/id"
import { Instance } from "@/project/instance"
import { fn } from "@/util/fn"
import { Wildcard } from "@/util/wildcard"
import z from "zod"

export namespace PermissionNext {
  export const Rule = Config.PermissionObject.meta({
    ref: "PermissionRule",
  })
  export type Rule = z.infer<typeof Rule>

  export const Ruleset = z.record(z.string(), Rule).meta({
    ref: "PermissionRuleset",
  })
  export type Ruleset = z.infer<typeof Ruleset>

  export function fromConfig(permission: Config.Permission) {
    const ruleset: Ruleset = {}
    for (const [key, value] of Object.entries(permission)) {
      if (typeof value === "string") {
        ruleset[key] = {
          "*": value,
        }
        continue
      }
      ruleset[key] = value
    }
    return ruleset
  }

  export function merge(...rulesets: Ruleset[]): Ruleset {
    const result: Ruleset = {}
    for (const ruleset of rulesets) {
      for (const [permission, rule] of Object.entries(ruleset)) {
        result[permission] ??= {}
        for (const [pattern, action] of Object.entries(rule)) {
          for (const existing of Object.keys(result[permission])) {
            if (Wildcard.match(existing, pattern)) {
              delete result[permission][existing]
            }
          }
          result[permission][pattern] = action
        }
      }
    }
    return result
  }

  export const Request = z
    .object({
      id: Identifier.schema("permission"),
      sessionID: Identifier.schema("session"),
      type: z.string(),
      title: z.string(),
      description: z.string(),
      keys: z.string().array(),
      patterns: z.string().array().optional(),
    })
    .meta({
      ref: "PermissionRequest",
    })

  export type Request = z.infer<typeof Request>

  export const Response = z.enum(["once", "always", "reject"])
  export type Response = z.infer<typeof Response>

  export const Approval = z.object({
    projectID: z.string(),
    patterns: z.string().array(),
  })

  export const Event = {
    Updated: BusEvent.define("permission.request", Request),
  }

  const state = Instance.state(() => {
    const pending: Record<
      string,
      {
        info: Request
        resolve: () => void
        reject: (e: any) => void
      }
    > = {}

    const approved: {
      [projectID: string]: Set<string>
    } = {}

    return {
      pending,
      approved,
    }
  })

  export const ask = fn(Request.partial({ id: true }), async (input) => {
    const id = input.id ?? Identifier.ascending("permission")
    return new Promise<void>((resolve, reject) => {
      const s = state()
      const info: Request = {
        id,
        ...input,
      }
      s.pending[id] = {
        info,
        resolve,
        reject,
      }
      Bus.publish(Event.Updated, info)
    })
  })

  export const respond = fn(
    z.object({
      permissionID: Identifier.schema("permission"),
      response: Response,
    }),
    async (input) => {
      const existing = state().pending[input.permissionID]
      if (!existing) return
      if (input.response === "reject") {
        existing.reject(new RejectedError())
        return
      }
      if (input.response === "once") {
        existing.resolve()
        return
      }
      if (input.response === "always") {
      }
    },
  )

  export const Action = z.enum(["allow", "deny", "ask"])
  export type Action = z.infer<typeof Action>

  export function evaluate(permission: string, pattern: string, ruleset: Ruleset): Action {
    const rule = ruleset[permission]
    if (!rule) return "ask"

    let best: { length: number; action: Action } | undefined
    for (const [p, action] of Object.entries(rule)) {
      if (!Wildcard.match(pattern, p)) continue
      if (!best || p.length > best.length) {
        best = { length: p.length, action }
      }
    }

    return best?.action ?? "ask"
  }

  export class RejectedError extends Error {
    constructor(public readonly reason?: string) {
      super(
        reason !== undefined
          ? reason
          : `The user rejected permission to use this specific tool call. You may try again with different parameters.`,
      )
    }
  }
}
