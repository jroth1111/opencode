import { Bus } from "@/bus"
import { BusEvent } from "@/bus/bus-event"
import { Config } from "@/config/config"
import { Identifier } from "@/id/id"
import { Instance } from "@/project/instance"
import { fn } from "@/util/fn"
import { Log } from "@/util/log"
import { Wildcard } from "@/util/wildcard"
import { sortBy } from "remeda"
import z from "zod"

export namespace PermissionNext {
  const log = Log.create({ service: "permission" })

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
        for (const existingPerm of Object.keys(result)) {
          if (Wildcard.match(existingPerm, permission)) {
            for (const [pattern, action] of Object.entries(rule)) {
              for (const existingPattern of Object.keys(result[existingPerm])) {
                if (Wildcard.match(existingPattern, pattern)) {
                  result[existingPerm][existingPattern] = action
                }
              }
            }
          }
        }
        result[permission] ??= {}
        for (const [pattern, action] of Object.entries(rule)) {
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
      patterns: z.string().array(),
      title: z.string(),
      description: z.string(),
      metadata: z.record(z.string(), z.any()),
      always: z.string().array(),
      permission: z.string(),
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
    Requested: BusEvent.define("permission.requested", Request),
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

  export const request = fn(
    Request.partial({ id: true }).extend({
      ruleset: Ruleset,
    }),
    async (input) => {
      const { ruleset, ...request } = input
      for (const pattern of request.patterns ?? []) {
        const action = evaluate(request.permission, pattern, ruleset)
        log.info("evaluated", { permission: request.permission, pattern, action })
        if (action === "deny") throw new RejectedError()
        if (action === "ask") {
          const id = input.id ?? Identifier.ascending("permission")
          return new Promise<void>((resolve, reject) => {
            const s = state()
            const info: Request = {
              id,
              ...request,
            }
            s.pending[id] = {
              info,
              resolve,
              reject,
            }
            Bus.publish(Event.Requested, info)
          })
        }
        if (action === "allow") continue
      }
    },
  )

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
    log.info("evaluate", { permission, pattern, ruleset })
    for (const [permissionPattern, rule] of sortBy(Object.entries(ruleset), [([k]) => k.length, "desc"])) {
      if (!Wildcard.match(permission, permissionPattern)) continue
      for (const [p, action] of sortBy(Object.entries(rule), [([k]) => k.length, "desc"])) {
        if (!Wildcard.match(pattern, p)) continue
        return action
      }
    }
    return "ask"
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
