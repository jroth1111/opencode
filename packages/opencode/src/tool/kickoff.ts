import z from "zod"
import { Tool } from "./tool"
import { Question } from "../question"
import { Session } from "../session"
import { mergeState, planModeFor, resolveConfig, type WorkflowTrack } from "../session/workflow"
import DESCRIPTION from "./kickoff.txt"
import fs from "fs/promises"
import path from "path"
import { Instance } from "../project/instance"

function firstAnswer(value: string[] | undefined): string | undefined {
  if (!value || value.length === 0) return
  const item = value[0]?.trim()
  return item?.length ? item : undefined
}

function yesNo(value: string[] | undefined): boolean | undefined {
  const item = firstAnswer(value)?.toLowerCase()
  if (!item) return
  if (item === "yes") return true
  if (item === "no") return false
  return undefined
}

function normalizeRisk(value: string | undefined): "low" | "medium" | "high" | undefined {
  if (!value) return
  const item = value.toLowerCase()
  if (item.startsWith("low")) return "low"
  if (item.startsWith("med")) return "medium"
  if (item.startsWith("high")) return "high"
  return undefined
}

function normalizeTrack(value: string | undefined): WorkflowTrack | undefined {
  if (!value) return
  const item = value.toLowerCase()
  if (item.startsWith("fast")) return "fast"
  if (item.startsWith("full")) return "full"
  return undefined
}

function yesNoLabel(value: boolean | undefined): string {
  if (value === true) return "Yes"
  if (value === false) return "No"
  return "n/a"
}

function formatList(items: string[]): string {
  if (items.length === 0) return "- n/a"
  return items.map((item) => `- ${item}`).join("\n")
}

export const KickoffTool = Tool.define("kickoff", async () => {
  return {
    description: DESCRIPTION,
    parameters: z.object({}),
    async execute(_params, ctx) {
      const session = await Session.get(ctx.sessionID)
      const answers = await Question.ask({
        sessionID: ctx.sessionID,
        questions: [
          {
            header: "Intent",
            question: "What is the intent or target of this change? (1 sentence)",
            options: [{ label: "Custom", description: "Describe the goal succinctly" }],
            custom: true,
          },
          {
            header: "Scope",
            question: "What is the scope of this work?",
            options: [{ label: "Custom", description: "Describe the scope briefly" }],
            custom: true,
          },
          {
            header: "Risk",
            question: "Risk tier?",
            options: [
              { label: "Low", description: "Low risk change" },
              { label: "Medium", description: "Moderate risk change" },
              { label: "High", description: "High risk change" },
            ],
            custom: false,
          },
          {
            header: "DoD",
            question: "Definition of done?",
            options: [{ label: "Custom", description: "Describe what done looks like" }],
            custom: true,
          },
          {
            header: "Accept",
            question: "Acceptance checks (how we know it works)?",
            options: [{ label: "Custom", description: "List acceptance checks" }],
            multiple: true,
            custom: true,
          },
          {
            header: "WSG-1",
            question: "External truth (3rd-party API/service/platform behavior)?",
            options: [
              { label: "Yes", description: "Depends on external truth" },
              { label: "No", description: "No external dependency" },
            ],
            custom: false,
          },
          {
            header: "WSG-2",
            question: "Versioned fact (API/flag/config/default/deprecation)?",
            options: [
              { label: "Yes", description: "Versioned behavior involved" },
              { label: "No", description: "No versioned facts" },
            ],
            custom: false,
          },
          {
            header: "WSG-3",
            question: "Failure you cannot explain locally (CI/test/lint/type/etc.)?",
            options: [
              { label: "Yes", description: "Unexplained failure exists" },
              { label: "No", description: "No unexplained failures" },
            ],
            custom: false,
          },
          {
            header: "WSG-4",
            question: "Security boundary or deps changed (auth/PII/secrets/etc.)?",
            options: [
              { label: "Yes", description: "Security boundary or deps changed" },
              { label: "No", description: "No security/deps concerns" },
            ],
            custom: false,
          },
          {
            header: "WSG-5",
            question: "High-cost decision (tool/library/architecture choice)?",
            options: [
              { label: "Yes", description: "High-cost decision involved" },
              { label: "No", description: "No high-cost decision" },
            ],
            custom: false,
          },
          {
            header: "Track",
            question: "Choose track",
            options: [
              { label: "Fast", description: "FAST TRACK (lite, safe)" },
              { label: "Full", description: "FULL CYCLE workflow" },
            ],
            custom: false,
          },
          {
            header: "Refs",
            question: "References/links (if any Web Search Gate answer is Yes)?",
            options: [{ label: "Custom", description: "List links or notes" }],
            multiple: true,
            custom: true,
          },
          {
            header: "Versions",
            question: "Versions confirmed (lockfile/toolchain/docs)?",
            options: [{ label: "Custom", description: "List versions" }],
            multiple: true,
            custom: true,
          },
        ],
        tool: ctx.callID ? { messageID: ctx.messageID, callID: ctx.callID } : undefined,
      })

      const intent = firstAnswer(answers[0])
      const scope = firstAnswer(answers[1])
      const risk = normalizeRisk(firstAnswer(answers[2]))
      const definitionOfDone = firstAnswer(answers[3])
      const acceptance = (answers[4] ?? []).filter((item) => item.trim().length > 0)
      const q1 = yesNo(answers[5])
      const q2 = yesNo(answers[6])
      const q3 = yesNo(answers[7])
      const q4 = yesNo(answers[8])
      const q5 = yesNo(answers[9])
      const track = normalizeTrack(firstAnswer(answers[10]))
      const references = (answers[11] ?? []).filter((item) => item.trim().length > 0)
      const versions = (answers[12] ?? []).filter((item) => item.trim().length > 0)

      const workflowConfig = await resolveConfig()
      const nextWorkflow = mergeState(session.workflow, workflowConfig)
      nextWorkflow.mode = "workflow"
      const existing = nextWorkflow.kickoff ?? {}
      nextWorkflow.kickoff = {
        intent: intent ?? existing.intent,
        scope: scope ?? existing.scope,
        risk: risk ?? existing.risk,
        definitionOfDone: definitionOfDone ?? existing.definitionOfDone,
        acceptance: acceptance.length > 0 ? acceptance : existing.acceptance,
        track: track ?? existing.track,
        webSearchGate: {
          q1ExternalTruth: q1 ?? existing.webSearchGate?.q1ExternalTruth,
          q2VersionedFact: q2 ?? existing.webSearchGate?.q2VersionedFact,
          q3UnexplainedFailure: q3 ?? existing.webSearchGate?.q3UnexplainedFailure,
          q4SecurityBoundary: q4 ?? existing.webSearchGate?.q4SecurityBoundary,
          q5HighCostDecision: q5 ?? existing.webSearchGate?.q5HighCostDecision,
          references: references.length > 0 ? references : existing.webSearchGate?.references,
          versions: versions.length > 0 ? versions : existing.webSearchGate?.versions,
        },
      }

      const planMode = planModeFor(workflowConfig, "workflow")
      if (track === "full" && planMode !== "off") {
        nextWorkflow.plan = {
          ...nextWorkflow.plan,
          required: true,
        }
      } else if (track === "fast" && planMode === "auto") {
        nextWorkflow.plan = {
          ...nextWorkflow.plan,
          required: false,
        }
      }

      await Session.update(session.id, (draft) => {
        draft.workflow = nextWorkflow
      })

      const kickoffPath = Session.kickoff(session)
      await fs.mkdir(path.dirname(kickoffPath), { recursive: true })
      const kickoffSummary = [
        "# Kickoff Summary",
        "",
        `Captured: ${new Date().toISOString()}`,
        `Session: ${session.title} (${session.id})`,
        "",
        "## Intent",
        intent ?? "n/a",
        "",
        "## Scope",
        scope ?? "n/a",
        "",
        "## Risk",
        risk ?? "n/a",
        "",
        "## Definition of Done",
        definitionOfDone ?? "n/a",
        "",
        "## Acceptance",
        formatList(acceptance),
        "",
        "## Web Search Gate",
        `- External truth: ${yesNoLabel(q1)}`,
        `- Versioned fact: ${yesNoLabel(q2)}`,
        `- Unexplained failure: ${yesNoLabel(q3)}`,
        `- Security boundary/deps: ${yesNoLabel(q4)}`,
        `- High-cost decision: ${yesNoLabel(q5)}`,
        "",
        "## References",
        formatList(references),
        "",
        "## Versions",
        formatList(versions),
        "",
        "## Track",
        track ?? "n/a",
        "",
        "## Mode",
        "workflow",
        "",
      ].join("\n")
      await Bun.write(kickoffPath, kickoffSummary)

      const kickoffLabel = (() => {
        const relative = path.relative(Instance.worktree, kickoffPath)
        return relative.startsWith("..") ? kickoffPath : relative
      })()
      const output = [
        `Intent: ${intent ?? "n/a"}`,
        `Scope: ${scope ?? "n/a"}`,
        `Risk: ${risk ?? "n/a"}`,
        `Definition of Done: ${definitionOfDone ?? "n/a"}`,
        `Acceptance: ${acceptance.length > 0 ? acceptance.join("; ") : "n/a"}`,
        `Web Search Gate: ${[q1, q2, q3, q4, q5].map((v) => yesNoLabel(v)).join(", ")}`,
        `References: ${references.length > 0 ? references.join("; ") : "n/a"}`,
        `Versions: ${versions.length > 0 ? versions.join("; ") : "n/a"}`,
        `Track: ${track ?? "n/a"}`,
        `Mode: workflow`,
        `Kickoff summary: ${kickoffLabel}`,
      ].join("\n")

      return {
        title: "Workflow kickoff captured",
        output,
        metadata: {},
      }
    },
  }
})
