import { Bus } from "@/bus"
import { Identifier } from "@/id/id"
import { Instance } from "@/project/instance"
import { fn } from "@/util/fn"
import z from "zod"

export namespace PermissionNext {
  export const Info = z
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
      ref: "PermissionNext",
    })

  export type Info = z.infer<typeof Info>

  export const Response = z.enum(["once", "always", "reject"])
  export type Response = z.infer<typeof Response>

  export const Approval = z.object({
    projectID: z.string(),
    patterns: z.string().array(),
  })

  export const Event = {
    Updated: Bus.event("permission.next.updated", Info),
  }

  const state = Instance.state(() => {
    const pending: Record<
      string,
      {
        info: Info
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

  export const ask = fn(Info.partial({ id: true }), async (input) => {
    const id = input.id ?? Identifier.ascending("permission")
    return new Promise<void>((resolve, reject) => {
      const s = state()
      s.pending[id] = {
        info: {
          id,
          ...input,
        },
        resolve,
        reject,
      }
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
