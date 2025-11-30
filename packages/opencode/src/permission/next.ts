import { Identifier } from "@/id/id"
import { Instance } from "@/project/instance"
import { fn } from "@/util/fn"
import z from "zod"

export namespace PermissionNext {
  export const Info = z
    .object({
      id: Identifier.schema("permission"),
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

  const state = Instance.state(() => {
    const pending: Record<
      string,
      {
        info: Info
        resolve: (info: Info) => void
        reject: (e: any) => void
      }
    > = {}
    return {
      pending,
    }
  })

  export const ask = fn(Info.partial({ id: true }), async (input) => {
    const id = input.id ?? Identifier.ascending("permission")
    return new Promise((resolve, reject) => {
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
