import net from "net"
import path from "path"
import { randomUUID } from "crypto"
import { Log } from "@/util/log"
import { Filesystem } from "@/util/filesystem"
import { Instance } from "@/project/instance"

export interface BeadsIssue {
  id: string
  title: string
  status?: string
  priority?: number
  issue_type?: string
  labels?: string[]
  external_ref?: string | null
}

export interface BeadsIssueWithCounts {
  issue: BeadsIssue
  dependency_count?: number
  dependent_count?: number
}

export interface BeadsListArgs {
  query?: string
  status?: string
  issue_type?: string
  assignee?: string
  labels?: string[]
  labels_any?: string[]
  ids?: string[]
  limit?: number
  include_templates?: boolean
  parent_id?: string
  ephemeral?: boolean
  exclude_status?: string[]
}

export interface BeadsCreateArgs {
  title: string
  description?: string
  issue_type?: string
  priority?: number
  labels?: string[]
  external_ref?: string
  ephemeral?: boolean
}

export interface BeadsUpdateArgs {
  id: string
  title?: string
  description?: string
  status?: string
  priority?: number
  issue_type?: string
  add_labels?: string[]
  remove_labels?: string[]
  set_labels?: string[]
  external_ref?: string
}

export interface BeadsCloseArgs {
  id: string
  reason?: string
  session?: string
}

interface RpcRequest {
  operation: string
  args: unknown
  cwd?: string
  request_id?: string
  client_version?: string
  expected_db?: string
}

interface RpcResponse {
  success: boolean
  data?: unknown
  error?: string
}

const log = Log.create({ service: "beads.client" })
const SOCKET_RELATIVE_PATH = path.join(".beads", "bd.sock")
const socketCache = new Map<string, string | undefined>()
const rpcUnavailable = new Map<string, boolean>()

async function findSocketPath(start: string) {
  if (socketCache.has(start)) return socketCache.get(start)
  const matches = await Filesystem.findUp(SOCKET_RELATIVE_PATH, start)
  const socketPath = matches[0]
  socketCache.set(start, socketPath)
  return socketPath
}

async function rpcRequest<T>(operation: string, args: unknown, cwd: string): Promise<T> {
  if (rpcUnavailable.get(cwd)) throw new Error("beads rpc unavailable")
  const socketPath = await findSocketPath(cwd)
  if (!socketPath) throw new Error("beads rpc socket not found")

  const request: RpcRequest = {
    operation,
    args,
    cwd,
    request_id: randomUUID(),
    client_version: "opencode",
  }

  const response = await new Promise<RpcResponse>((resolve, reject) => {
    const conn = net.createConnection(socketPath)
    const chunks: Buffer[] = []
    let resolved = false

    conn.on("error", (error) => {
      if (!resolved) reject(error)
    })

    conn.on("data", (data) => {
      chunks.push(data)
      const joined = Buffer.concat(chunks).toString("utf8")
      const idx = joined.indexOf("\n")
      if (idx === -1) return
      const line = joined.slice(0, idx).trim()
      if (!line) return
      resolved = true
      conn.end()
      try {
        resolve(JSON.parse(line) as RpcResponse)
      } catch (error) {
        reject(error)
      }
    })

    conn.on("connect", () => {
      const payload = JSON.stringify(request) + "\n"
      conn.write(payload)
    })
  })

  if (!response.success) {
    throw new Error(response.error || "beads rpc error")
  }

  return response.data as T
}

async function cliRequest<T>(args: string[], cwd: string): Promise<T> {
  const bd = Bun.which("bd")
  if (!bd) throw new Error("bd not found")
  const proc = Bun.spawn([bd, ...args, "--json"], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  if (exitCode !== 0) {
    throw new Error(stderr.trim() || `bd exited with ${exitCode}`)
  }
  const output = stdout.trim()
  if (!output) throw new Error("bd returned empty response")
  return JSON.parse(output) as T
}

async function request<T>(operation: string, args: unknown, cwd: string, cli: string[]): Promise<T> {
  try {
    return await rpcRequest<T>(operation, args, cwd)
  } catch (error) {
    rpcUnavailable.set(cwd, true)
    log.warn("rpc fallback to cli", { error })
    return cliRequest<T>(cli, cwd)
  }
}

function cwdFromInstance() {
  return Instance.directory
}

export const Beads = {
  async list(args: BeadsListArgs): Promise<BeadsIssue[]> {
    const cwd = cwdFromInstance()
    const data = await request<BeadsIssueWithCounts[]>(
      "list",
      {
        query: args.query,
        status: args.status,
        issue_type: args.issue_type,
        assignee: args.assignee,
        labels: args.labels,
        labels_any: args.labels_any,
        ids: args.ids,
        limit: args.limit ?? 0,
        include_templates: args.include_templates ?? false,
        parent_id: args.parent_id,
        ephemeral: args.ephemeral,
        exclude_status: args.exclude_status,
      },
      cwd,
      buildListArgs(args),
    )

    return data.map((item) => item.issue)
  },

  async create(args: BeadsCreateArgs): Promise<BeadsIssue> {
    const cwd = cwdFromInstance()
    return request<BeadsIssue>(
      "create",
      {
        title: args.title,
        description: args.description,
        issue_type: args.issue_type ?? "task",
        priority: args.priority ?? 2,
        labels: args.labels,
        external_ref: args.external_ref,
        ephemeral: args.ephemeral ?? false,
      },
      cwd,
      buildCreateArgs(args),
    )
  },

  async update(args: BeadsUpdateArgs): Promise<BeadsIssue> {
    const cwd = cwdFromInstance()
    return request<BeadsIssue>(
      "update",
      {
        id: args.id,
        title: args.title,
        description: args.description,
        status: args.status,
        priority: args.priority,
        issue_type: args.issue_type,
        add_labels: args.add_labels,
        remove_labels: args.remove_labels,
        set_labels: args.set_labels,
        external_ref: args.external_ref,
      },
      cwd,
      buildUpdateArgs(args),
    )
  },

  async close(args: BeadsCloseArgs): Promise<BeadsIssue> {
    const cwd = cwdFromInstance()
    return request<BeadsIssue>(
      "close",
      {
        id: args.id,
        reason: args.reason,
        session: args.session,
      },
      cwd,
      buildCloseArgs(args),
    )
  },
}

function buildListArgs(args: BeadsListArgs) {
  const cliArgs = ["list", "--status", args.status ?? "all", "--limit", String(args.limit ?? 0)]
  if (args.labels && args.labels.length > 0) {
    cliArgs.push("--label", args.labels.join(","))
  }
  if (args.labels_any && args.labels_any.length > 0) {
    cliArgs.push("--label-any", args.labels_any.join(","))
  }
  if (args.issue_type) {
    cliArgs.push("--type", args.issue_type)
  }
  if (args.assignee) {
    cliArgs.push("--assignee", args.assignee)
  }
  if (args.query) {
    cliArgs.push(args.query)
  }
  return cliArgs
}

function buildCreateArgs(args: BeadsCreateArgs) {
  const cliArgs = ["create", args.title]
  cliArgs.push("--type", args.issue_type ?? "task")
  cliArgs.push("--priority", String(args.priority ?? 2))
  if (args.labels && args.labels.length > 0) {
    cliArgs.push("--labels", args.labels.join(","))
  }
  if (args.external_ref) {
    cliArgs.push("--external-ref", args.external_ref)
  }
  if (args.ephemeral) {
    cliArgs.push("--ephemeral")
  }
  if (args.description) {
    cliArgs.push("--description", args.description)
  }
  return cliArgs
}

function buildUpdateArgs(args: BeadsUpdateArgs) {
  const cliArgs = ["update", args.id]
  if (args.status) cliArgs.push("--status", args.status)
  if (args.title) cliArgs.push("--title", args.title)
  if (args.description) cliArgs.push("--description", args.description)
  if (args.issue_type) cliArgs.push("--type", args.issue_type)
  if (args.priority !== undefined) cliArgs.push("--priority", String(args.priority))
  if (args.add_labels && args.add_labels.length > 0) cliArgs.push("--add-label", args.add_labels.join(","))
  if (args.remove_labels && args.remove_labels.length > 0)
    cliArgs.push("--remove-label", args.remove_labels.join(","))
  if (args.set_labels && args.set_labels.length > 0) cliArgs.push("--set-labels", args.set_labels.join(","))
  if (args.external_ref) cliArgs.push("--external-ref", args.external_ref)
  return cliArgs
}

function buildCloseArgs(args: BeadsCloseArgs) {
  const cliArgs = ["close", args.id]
  if (args.reason) cliArgs.push("--reason", args.reason)
  if (args.session) cliArgs.push("--session", args.session)
  return cliArgs
}
