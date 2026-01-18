import { Provider } from "@/provider/provider"

import { fn } from "@/util/fn"
import z from "zod"
import { Session } from "."

import { MessageV2 } from "./message-v2"
import { Identifier } from "@/id/id"
import { Snapshot } from "@/snapshot"

import { Log } from "@/util/log"
import path from "path"
import { Instance } from "@/project/instance"
import { Storage } from "@/storage/storage"
import { Bus } from "@/bus"
import { TaskState } from "@/task/state"

import { LLM } from "./llm"
import { Agent } from "@/agent/agent"

export namespace SessionSummary {
  const log = Log.create({ service: "session.summary" })

  export const summarize = fn(
    z.object({
      sessionID: z.string(),
      messageID: z.string(),
    }),
    async (input) => {
      const all = await Session.messages({ sessionID: input.sessionID })
      await Promise.all([
        summarizeSession({ sessionID: input.sessionID, messages: all }),
        summarizeMessage({ messageID: input.messageID, messages: all }),
      ])
    },
  )

  async function summarizeSession(input: { sessionID: string; messages: MessageV2.WithParts[] }) {
    const files = new Set(
      input.messages
        .flatMap((x) => x.parts)
        .filter((x) => x.type === "patch")
        .flatMap((x) => x.files)
        .map((x) => path.relative(Instance.worktree, x)),
    )
    const diffs = await computeDiff({ messages: input.messages }).then((x) =>
      x.filter((x) => {
        return files.has(x.file)
      }),
    )
    await Session.update(input.sessionID, (draft) => {
      draft.summary = {
        additions: diffs.reduce((sum, x) => sum + x.additions, 0),
        deletions: diffs.reduce((sum, x) => sum + x.deletions, 0),
        files: diffs.length,
      }
    })
    await Storage.write(["session_diff", input.sessionID], diffs)
    Bus.publish(Session.Event.Diff, {
      sessionID: input.sessionID,
      diff: diffs,
    })
  }

  async function summarizeMessage(input: { messageID: string; messages: MessageV2.WithParts[] }) {
    const messages = input.messages.filter(
      (m) => m.info.id === input.messageID || (m.info.role === "assistant" && m.info.parentID === input.messageID),
    )
    const msgWithParts = messages.find((m) => m.info.id === input.messageID)
    if (!msgWithParts) throw new Error(`Message not found: ${input.messageID}`)
    const userMsg = msgWithParts.info as MessageV2.User
    const diffs = await computeDiff({ messages })
    userMsg.summary = {
      ...userMsg.summary,
      diffs,
    }
    await Session.updateMessage(userMsg)

    const textPart = msgWithParts.parts.find((p) => p.type === "text" && !p.synthetic) as MessageV2.TextPart
    if (textPart && !userMsg.summary?.title) {
      const agent = await Agent.get("title")
      const stream = await LLM.stream({
        agent,
        user: userMsg,
        tools: {},
        model: agent.model
          ? await Provider.getModel(agent.model.providerID, agent.model.modelID)
          : ((await Provider.getSmallModel(userMsg.model.providerID)) ??
            (await Provider.getModel(userMsg.model.providerID, userMsg.model.modelID))),
        small: true,
        messages: [
          {
            role: "user" as const,
            content: `
              The following is the text to summarize:
              <text>
              ${textPart?.text ?? ""}
              </text>
            `,
          },
        ],
        abort: new AbortController().signal,
        sessionID: userMsg.sessionID,
        system: [],
        retries: 3,
      })
      const result = await stream.text
      log.info("title", { title: result })
      userMsg.summary.title = result
      await Session.updateMessage(userMsg)
    }

    await updateTaskNotes({ messages })
  }

  export const diff = fn(
    z.object({
      sessionID: Identifier.schema("session"),
      messageID: Identifier.schema("message").optional(),
    }),
    async (input) => {
      return Storage.read<Snapshot.FileDiff[]>(["session_diff", input.sessionID]).catch(() => [])
    },
  )

  async function computeDiff(input: { messages: MessageV2.WithParts[] }) {
    let from: string | undefined
    let to: string | undefined

    // scan assistant messages to find earliest from and latest to
    // snapshot
    for (const item of input.messages) {
      if (!from) {
        for (const part of item.parts) {
          if (part.type === "step-start" && part.snapshot) {
            from = part.snapshot
            break
          }
        }
      }

      for (const part of item.parts) {
        if (part.type === "step-finish" && part.snapshot) {
          to = part.snapshot
          break
        }
      }
    }

    if (from && to) return Snapshot.diffFull(from, to)
    return []
  }

  function collectNoteText(messages: MessageV2.WithParts[]) {
    const chunks: string[] = []
    for (const msg of messages) {
      const role = msg.info.role.toUpperCase()
      for (const part of msg.parts) {
        if (part.type !== "text") continue
        if (part.synthetic) continue
        const text = part.text.trim()
        if (!text) continue
        chunks.push(`${role}: ${text}`)
        if (chunks.join("\n").length > 12_000) break
      }
      if (chunks.join("\n").length > 12_000) break
    }
    return chunks.join("\n")
  }

  function extractNotesFromText(text: string) {
    const decisions: string[] = []
    const blockers: string[] = []
    const seenDecisions = new Set<string>()
    const seenBlockers = new Set<string>()

    let mode: "decisions" | "blockers" | undefined
    const lines = text.split(/\r?\n/)
    for (const raw of lines) {
      const line = raw.trim()
      if (!line) {
        mode = undefined
        continue
      }

      const heading = line.match(/^(decisions?|blockers?)\s*[:\-]?\s*(.*)$/i)
      if (heading) {
        mode = heading[1].toLowerCase().startsWith("decision") ? "decisions" : "blockers"
        const rest = heading[2]?.trim()
        if (rest) {
          const target = mode === "decisions" ? decisions : blockers
          const seen = mode === "decisions" ? seenDecisions : seenBlockers
          if (!seen.has(rest)) {
            seen.add(rest)
            target.push(rest)
          }
        }
        continue
      }

      const bullet = line.match(/^(?:[-*]|\d+[.)])\s+(.*)$/)
      if (bullet && mode) {
        const item = bullet[1].trim()
        if (!item) continue
        const target = mode === "decisions" ? decisions : blockers
        const seen = mode === "decisions" ? seenDecisions : seenBlockers
        if (!seen.has(item)) {
          seen.add(item)
          target.push(item)
        }
      }
    }

    return { decisions, blockers }
  }

  function mergeNotes(existing: string[] | undefined, incoming: string[]) {
    const merged = existing ? [...existing] : []
    const seen = new Set(merged)
    for (const item of incoming) {
      if (!item) continue
      if (seen.has(item)) continue
      seen.add(item)
      merged.push(item)
    }
    return merged
  }

  async function updateTaskNotes(input: { messages: MessageV2.WithParts[] }) {
    const text = collectNoteText(input.messages)
    if (!text) return
    const { decisions, blockers } = extractNotesFromText(text)
    if (decisions.length === 0 && blockers.length === 0) return

    const existing = await TaskState.get().catch(() => undefined)
    const nextDecisions = mergeNotes(existing?.decisions, decisions)
    const nextBlockers = mergeNotes(existing?.blockers, blockers)

    const decisionsChanged =
      (existing?.decisions?.length ?? 0) !== nextDecisions.length
    const blockersChanged =
      (existing?.blockers?.length ?? 0) !== nextBlockers.length
    if (!decisionsChanged && !blockersChanged) return

    await TaskState.updateNotes({
      decisions: nextDecisions,
      blockers: nextBlockers,
    })
  }
}
