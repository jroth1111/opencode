import fs from "fs/promises"
import path from "path"
import crypto from "crypto"
import { Global } from "@/global"
import { Instance } from "@/project/instance"
import { Identifier } from "@/id/id"
import { Config } from "@/config/config"

export namespace CapabilityToken {
  export type Scope = {
    rootTodoId: string
    allowChildren: boolean
    allowParentRead: boolean
    allowDepsRead: boolean
  }

  export type Info = {
    id: string
    runId: string
    scope: Scope
    depthRemaining?: number
    expiresAt?: string
    revokedAt?: string
    signature: string
  }

  function tokenDir() {
    const base = Instance.project.vcs ? path.join(Instance.worktree, ".opencode") : Global.Path.data
    return path.join(base, "task-runs", "tokens")
  }

  function tokenPath(tokenId: string) {
    return path.join(tokenDir(), `${tokenId}.json`)
  }

  async function secretPath() {
    const base = Instance.project.vcs ? path.join(Instance.worktree, ".opencode") : Global.Path.data
    return path.join(base, "capability.secret")
  }

  async function getSecret() {
    const cfg = await Config.get()
    const fromConfig = cfg.task?.taskrun?.capability_secret
    if (fromConfig) return fromConfig
    const file = await secretPath()
    const existing = await Bun.file(file)
      .text()
      .then((text) => text.trim())
      .catch(() => "")
    if (existing) return existing
    const generated = crypto.randomBytes(32).toString("hex")
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, generated)
    return generated
  }

  function buildPayload(input: {
    id: string
    runId: string
    scope: Scope
    depthRemaining?: number
    expiresAt?: string
  }) {
    const scopeKey = [
      input.scope.rootTodoId,
      input.scope.allowChildren ? "1" : "0",
      input.scope.allowParentRead ? "1" : "0",
      input.scope.allowDepsRead ? "1" : "0",
    ].join("|")
    return `${input.id}:${input.runId}:${input.expiresAt ?? ""}:${input.depthRemaining ?? ""}:${scopeKey}`
  }

  async function sign(payload: string) {
    const secret = await getSecret()
    return crypto.createHmac("sha256", secret).update(payload).digest("hex")
  }

  async function writeToken(token: Info) {
    const dir = tokenDir()
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(tokenPath(token.id), JSON.stringify(token, null, 2))
  }

  async function readToken(tokenId: string): Promise<Info | undefined> {
    const file = tokenPath(tokenId)
    const data = await Bun.file(file)
      .json()
      .catch(() => undefined)
    return data as Info | undefined
  }

  export async function create(input: {
    runId: string
    scope: Scope
    depthRemaining?: number
    expiresAt?: string
  }) {
    const id = Identifier.ascending("cap")
    const payload = buildPayload({
      id,
      runId: input.runId,
      scope: input.scope,
      depthRemaining: input.depthRemaining,
      expiresAt: input.expiresAt,
    })
    const signature = await sign(payload)
    const token: Info = {
      id,
      runId: input.runId,
      scope: input.scope,
      depthRemaining: input.depthRemaining,
      expiresAt: input.expiresAt,
      signature,
    }
    await writeToken(token)
    return token
  }

  export async function get(tokenId: string) {
    return readToken(tokenId)
  }

  export async function revoke(tokenId: string) {
    const token = await readToken(tokenId)
    if (!token) return
    const next: Info = {
      ...token,
      revokedAt: new Date().toISOString(),
    }
    await writeToken(next)
    return next
  }

  export async function verify(token: Info) {
    const payload = buildPayload({
      id: token.id,
      runId: token.runId,
      scope: token.scope,
      depthRemaining: token.depthRemaining,
      expiresAt: token.expiresAt,
    })
    const expected = await sign(payload)
    return expected === token.signature
  }

  export async function assertValid(token: Info) {
    if (token.revokedAt) {
      throw new Error(`Capability token ${token.id} revoked`)
    }
    if (token.expiresAt && Date.now() > Date.parse(token.expiresAt)) {
      throw new Error(`Capability token ${token.id} expired`)
    }
    if (!(await verify(token))) {
      throw new Error(`Capability token ${token.id} signature mismatch`)
    }
  }
}
