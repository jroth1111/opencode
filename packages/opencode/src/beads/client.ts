import net from "net"
import path from "path"
import { randomUUID } from "crypto"
import z from "zod"
import { Log } from "@/util/log"
import { Filesystem } from "@/util/filesystem"
import { Instance } from "@/project/instance"
import {
  BeadsIssueSchema,
  BeadsIssueWithCountsSchema,
  BeadsListArgsSchema,
  BeadsReadyArgsSchema,
  BeadsCreateArgsSchema,
  BeadsUpdateArgsSchema,
  BeadsCloseArgsSchema,
  BeadsDepAddArgsSchema,
  BeadsDepRemoveArgsSchema,
  BeadsCommentSchema,
  BeadsCommentListArgsSchema,
  BeadsCommentAddArgsSchema,
  RpcRequestSchema,
  RpcResponseSchema,
  type BeadsIssue,
  type BeadsIssueWithCounts,
  type BeadsListArgs,
  type BeadsReadyArgs,
  type BeadsCreateArgs,
  type BeadsUpdateArgs,
  type BeadsCloseArgs,
  type BeadsDepAddArgs,
  type BeadsDepRemoveArgs,
  type BeadsComment,
  type BeadsCommentListArgs,
  type BeadsCommentAddArgs,
} from "@/beads/protocol"

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

function parseSchema<T>(schema: z.ZodType<T>, data: unknown, context: string): T {
  const parsed = schema.safeParse(data)
  if (!parsed.success) {
    throw new Error(`beads ${context} response invalid: ${parsed.error.message}`)
  }
  return parsed.data
}

async function rpcRequest(operation: string, args: unknown, cwd: string): Promise<unknown> {
  if (rpcUnavailable.get(cwd)) throw new Error("beads rpc unavailable")
  const socketPath = await findSocketPath(cwd)
  if (!socketPath) throw new Error("beads rpc socket not found")

  const request = RpcRequestSchema.parse({
    operation,
    args,
    cwd,
    request_id: randomUUID(),
    client_version: "opencode",
  })

  const response = await new Promise<unknown>((resolve, reject) => {
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
        const parsed = parseSchema(RpcResponseSchema, JSON.parse(line), "rpc")
        if (!parsed.success) {
          reject(new Error(parsed.error || "beads rpc error"))
          return
        }
        resolve(parsed.data)
      } catch (error) {
        reject(error)
      }
    })

    conn.on("connect", () => {
      const payload = JSON.stringify(request) + "\n"
      conn.write(payload)
    })
  })

  return response
}

async function cliRequest(args: string[], cwd: string): Promise<unknown> {
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
  return JSON.parse(output) as unknown
}

async function request<T>(
  operation: string,
  args: unknown,
  cwd: string,
  cli: string[],
  schema: z.ZodType<T>,
): Promise<T> {
  const data = await requestRaw(operation, args, cwd, cli)
  return parseSchema(schema, data, operation)
}

async function requestRaw(operation: string, args: unknown, cwd: string, cli: string[]): Promise<unknown> {
  try {
    return await rpcRequest(operation, args, cwd)
  } catch (error) {
    rpcUnavailable.set(cwd, true)
    log.warn("rpc fallback to cli", { error })
    return cliRequest(cli, cwd)
  }
}

function cwdFromInstance() {
  return Instance.directory
}

export const Beads = {
  async list(args: BeadsListArgs): Promise<BeadsIssue[]> {
    const cwd = cwdFromInstance()
    const listArgs = BeadsListArgsSchema.parse({
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
    })
    const data = await request<BeadsIssueWithCounts[]>(
      "list",
      listArgs,
      cwd,
      buildListArgs(listArgs),
      z.array(BeadsIssueWithCountsSchema),
    )

    return data.map((item) => item.issue)
  },

  async ready(args: BeadsReadyArgs): Promise<BeadsIssue[]> {
    const cwd = cwdFromInstance()
    const readyArgs = BeadsReadyArgsSchema.parse({
      assignee: args.assignee,
      unassigned: args.unassigned,
      priority: args.priority,
      issue_type: args.issue_type,
      limit: args.limit ?? 10,
      sort: args.sort ?? "hybrid",
      labels: args.labels,
      labels_any: args.labels_any,
      parent_id: args.parent_id,
      mol_type: args.mol_type,
      include_deferred: args.include_deferred,
    })
    return request<BeadsIssue[]>(
      "ready",
      buildReadyRpcArgs(readyArgs),
      cwd,
      buildReadyArgs(readyArgs),
      z.array(BeadsIssueSchema),
    )
  },

  async create(args: BeadsCreateArgs): Promise<BeadsIssue> {
    const cwd = cwdFromInstance()
    const createArgs = BeadsCreateArgsSchema.parse({
      title: args.title,
      description: args.description,
      design: args.design,
      acceptance_criteria: args.acceptance_criteria,
      notes: args.notes,
      issue_type: args.issue_type ?? "task",
      priority: args.priority ?? 2,
      assignee: args.assignee,
      labels: args.labels,
      dependencies: args.dependencies,
      parent: args.parent,
      estimated_minutes: args.estimated_minutes,
      external_ref: args.external_ref,
      ephemeral: args.ephemeral ?? false,
      status: args.status,
    })
    return request<BeadsIssue>(
      "create",
      createArgs,
      cwd,
      buildCreateArgs(createArgs),
      BeadsIssueSchema,
    )
  },

  async update(args: BeadsUpdateArgs): Promise<BeadsIssue> {
    const cwd = cwdFromInstance()
    const updateArgs = BeadsUpdateArgsSchema.parse({
      id: args.id,
      title: args.title,
      description: args.description,
      status: args.status,
      priority: args.priority,
      design: args.design,
      acceptance_criteria: args.acceptance_criteria,
      notes: args.notes,
      assignee: args.assignee,
      estimated_minutes: args.estimated_minutes,
      issue_type: args.issue_type,
      add_labels: args.add_labels,
      remove_labels: args.remove_labels,
      set_labels: args.set_labels,
      external_ref: args.external_ref,
    })
    return request<BeadsIssue>(
      "update",
      updateArgs,
      cwd,
      buildUpdateArgs(updateArgs),
      BeadsIssueSchema,
    )
  },

  async close(args: BeadsCloseArgs): Promise<BeadsIssue> {
    const cwd = cwdFromInstance()
    const closeArgs = BeadsCloseArgsSchema.parse({
      id: args.id,
      reason: args.reason,
      session: args.session,
    })
    return request<BeadsIssue>(
      "close",
      closeArgs,
      cwd,
      buildCloseArgs(closeArgs),
      BeadsIssueSchema,
    )
  },

  comments: {
    async list(args: BeadsCommentListArgs): Promise<BeadsComment[]> {
      const cwd = cwdFromInstance()
      const listArgs = BeadsCommentListArgsSchema.parse({
        id: args.id,
      })
      return request<BeadsComment[]>(
        "comment_list",
        listArgs,
        cwd,
        buildCommentListArgs(listArgs),
        z.array(BeadsCommentSchema),
      )
    },
    async add(args: BeadsCommentAddArgs): Promise<BeadsComment> {
      const cwd = cwdFromInstance()
      const addArgs = BeadsCommentAddArgsSchema.parse({
        id: args.id,
        author: args.author,
        text: args.text,
      })
      return request<BeadsComment>(
        "comment_add",
        addArgs,
        cwd,
        buildCommentAddArgs(addArgs),
        BeadsCommentSchema,
      )
    },
  },
  deps: {
    async add(args: BeadsDepAddArgs): Promise<void> {
      const cwd = cwdFromInstance()
      const addArgs = BeadsDepAddArgsSchema.parse({
        from_id: args.from_id,
        to_id: args.to_id,
        dep_type: args.dep_type ?? "blocks",
      })
      await request<unknown>(
        "dep_add",
        addArgs,
        cwd,
        buildDepAddArgs(addArgs),
        z.unknown(),
      )
    },
    async remove(args: BeadsDepRemoveArgs): Promise<void> {
      const cwd = cwdFromInstance()
      const removeArgs = BeadsDepRemoveArgsSchema.parse({
        from_id: args.from_id,
        to_id: args.to_id,
        dep_type: args.dep_type,
      })
      await request<unknown>(
        "dep_remove",
        removeArgs,
        cwd,
        buildDepRemoveArgs(removeArgs),
        z.unknown(),
      )
    },
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

function buildReadyRpcArgs(args: BeadsReadyArgs) {
  return {
    assignee: args.assignee,
    unassigned: args.unassigned,
    priority: args.priority,
    type: args.issue_type,
    limit: args.limit,
    sort_policy: args.sort,
    labels: args.labels,
    labels_any: args.labels_any,
    parent_id: args.parent_id,
    mol_type: args.mol_type,
    include_deferred: args.include_deferred,
  }
}

function buildReadyArgs(args: BeadsReadyArgs) {
  const cliArgs = ["ready", "--limit", String(args.limit ?? 10), "--sort", args.sort ?? "hybrid"]
  if (args.issue_type) {
    cliArgs.push("--type", args.issue_type)
  }
  if (args.assignee) {
    cliArgs.push("--assignee", args.assignee)
  }
  if (args.unassigned) {
    cliArgs.push("--unassigned")
  }
  if (args.priority !== undefined) {
    cliArgs.push("--priority", String(args.priority))
  }
  if (args.labels && args.labels.length > 0) {
    cliArgs.push("--label", args.labels.join(","))
  }
  if (args.labels_any && args.labels_any.length > 0) {
    cliArgs.push("--label-any", args.labels_any.join(","))
  }
  if (args.parent_id) {
    cliArgs.push("--parent", args.parent_id)
  }
  if (args.mol_type) {
    cliArgs.push("--mol-type", args.mol_type)
  }
  if (args.include_deferred) {
    cliArgs.push("--include-deferred")
  }
  return cliArgs
}

function buildCreateArgs(args: BeadsCreateArgs) {
  const cliArgs = ["create", args.title]
  cliArgs.push("--type", args.issue_type ?? "task")
  cliArgs.push("--priority", String(args.priority ?? 2))
  if (args.status) {
    cliArgs.push("--status", args.status)
  }
  if (args.parent) {
    cliArgs.push("--parent", args.parent)
  }
  if (args.dependencies && args.dependencies.length > 0) {
    cliArgs.push("--deps", args.dependencies.join(","))
  }
  if (args.labels && args.labels.length > 0) {
    cliArgs.push("--labels", args.labels.join(","))
  }
  if (args.assignee) {
    cliArgs.push("--assignee", args.assignee)
  }
  if (args.design) {
    cliArgs.push("--design", args.design)
  }
  if (args.acceptance_criteria) {
    cliArgs.push("--acceptance", args.acceptance_criteria)
  }
  if (args.notes) {
    cliArgs.push("--notes", args.notes)
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

function buildCommentListArgs(args: BeadsCommentListArgs) {
  return ["comments", args.id]
}

function buildCommentAddArgs(args: BeadsCommentAddArgs) {
  const cliArgs = ["comments", "add", args.id, args.text]
  if (args.author) {
    cliArgs.push("--author", args.author)
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
  if (args.assignee) cliArgs.push("--assignee", args.assignee)
  if (args.design) cliArgs.push("--design", args.design)
  if (args.acceptance_criteria) cliArgs.push("--acceptance", args.acceptance_criteria)
  if (args.notes) cliArgs.push("--notes", args.notes)
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

function buildDepAddArgs(args: BeadsDepAddArgs) {
  const cliArgs = ["dep", "add", args.from_id, args.to_id]
  if (args.dep_type) {
    cliArgs.push("--type", args.dep_type)
  }
  return cliArgs
}

function buildDepRemoveArgs(args: BeadsDepRemoveArgs) {
  const cliArgs = ["dep", "remove", args.from_id, args.to_id]
  if (args.dep_type) {
    cliArgs.push("--type", args.dep_type)
  }
  return cliArgs
}
