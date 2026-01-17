import z from "zod"
import { Tool } from "./tool"
import { Session } from "../session"
import { Question } from "../question"
import { Todo } from "@/session/todo"
import { Task } from "@/task"
import { isKickoffComplete, mergeState, planModeFor, resolveConfig } from "../session/workflow"
import DESCRIPTION from "./finish.txt"

export const FinishTool = Tool.define("finish", async () => {
  return {
    description: DESCRIPTION,
    parameters: z.object({}),
    async execute(_params, ctx) {
      const session = await Session.get(ctx.sessionID)
      const workflowConfig = await resolveConfig()
      const workflowState = mergeState(session.workflow, workflowConfig)
      const mode = workflowState.mode ?? workflowConfig.mode
      const planMode = planModeFor(workflowConfig, mode)

      if (mode !== "workflow") {
        return {
          title: "Finish",
          output: "Minimal mode: no finish gate enforced.",
          metadata: {},
        }
      }

      const errors: string[] = []
      if (!isKickoffComplete(workflowState.kickoff)) {
        errors.push("Kickoff incomplete (run kickoff)")
      }
      if (planMode !== "off" && !workflowState.plan?.approved) {
        errors.push("Plan not approved (run plan_exit)")
      }
      if (workflowConfig.verify.afterEdit && workflowState.verify?.required) {
        errors.push("Verification required (run tests/lint/typecheck)")
      }

      const todos = await Todo.get(session.id)
      const blocking = todos.filter((todo) => Task.isBlockingStatus(todo.status))
      if (blocking.length > 0) {
        errors.push(`${blocking.length} blocking todo(s) remain`)
      }

      const gate = workflowState.kickoff?.webSearchGate
      const gateYes =
        gate &&
        [gate.q1ExternalTruth, gate.q2VersionedFact, gate.q3UnexplainedFailure, gate.q4SecurityBoundary, gate.q5HighCostDecision].some(
          (val) => val === true,
        )
      if (gateYes) {
        const refs = gate?.references?.length ?? 0
        const versions = gate?.versions?.length ?? 0
        if (refs === 0) errors.push("Web Search Gate: references required")
        if (versions === 0) errors.push("Web Search Gate: versions required")
      }

      if (errors.length > 0) {
        throw new Error(`Finish blocked:\n- ${errors.join("\n- ")}`)
      }

      const answers = await Question.ask({
        sessionID: ctx.sessionID,
        questions: [
          {
            header: "Acceptance",
            question: "Have the acceptance checks been verified?",
            options: [
              { label: "Yes", description: "Acceptance checks have been verified" },
              { label: "No", description: "Acceptance checks are not verified" },
            ],
            custom: false,
          },
        ],
        tool: ctx.callID ? { messageID: ctx.messageID, callID: ctx.callID } : undefined,
      })

      const answer = answers[0]?.[0]
      if (answer !== "Yes") {
        throw new Question.RejectedError()
      }

      return {
        title: "Finish gate passed",
        output: "All workflow gates satisfied. Safe to declare done.",
        metadata: {},
      }
    },
  }
})
