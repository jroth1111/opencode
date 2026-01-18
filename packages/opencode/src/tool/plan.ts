import z from "zod"
import path from "path"
import fs from "fs/promises"
import { Tool } from "./tool"
import { Session } from "../session"
import { Instance } from "../project/instance"
import { describeMissingPlanSections, mergeState, resolveConfig, validatePlanText } from "../session/workflow"
import EXIT_DESCRIPTION from "./plan-exit.txt"
import ENTER_DESCRIPTION from "./plan-enter.txt"
import PROMPT_PLAN_EXEC from "../session/prompt/plan-exec.txt"

async function ensurePlanSeed(planPath: string) {
  await fs.mkdir(path.dirname(planPath), { recursive: true })
  const file = Bun.file(planPath)
  const exists = await file.exists()
  if (exists) {
    const text = await file.text().catch(() => "")
    if (text.trim().length > 0) {
      return { seeded: false, exists: true }
    }
  }
  const content = `${PROMPT_PLAN_EXEC.trimEnd()}\n`
  await Bun.write(planPath, content)
  return { seeded: true, exists }
}

export const PlanExitTool = Tool.define("plan_exit", {
  description: EXIT_DESCRIPTION,
  parameters: z.object({}),
  async execute(_params, ctx) {
    const session = await Session.get(ctx.sessionID)
    const planPath = Session.plan(session)
    const plan = path.relative(Instance.worktree, planPath)
    const workflowConfig = await resolveConfig()
    const file = Bun.file(planPath)
    const exists = await file.exists()
    const planText = exists ? await file.text().catch(() => "") : ""
    const missing = validatePlanText(planText)
    if (missing.length > 0) {
      const labels = describeMissingPlanSections(missing)
      const missingList = labels.map((label) => `- ${label}`).join("\n")
      const reason = exists ? "Plan is missing required sections" : "Plan file is missing or empty"
      throw new Error(
        `${reason} at ${plan}.\nMissing sections:\n${missingList}\n\nUpdate the plan and run plan_exit again.`,
      )
    }
    const nextWorkflow = mergeState(session.workflow, workflowConfig)
    nextWorkflow.mode = nextWorkflow.mode ?? workflowConfig.mode
    nextWorkflow.plan = {
      ...nextWorkflow.plan,
      approved: true,
      required: false,
      lastPlanPath: planPath,
      lastPlanUpdatedAt: Date.now(),
    }
    await Session.update(session.id, (draft) => {
      draft.workflow = nextWorkflow
    })

    return {
      title: "Plan approved",
      output: `Plan at ${plan} approved. You may now proceed with execution.`,
      metadata: {},
    }
  },
})

export const PlanEnterTool = Tool.define("plan_enter", {
  description: ENTER_DESCRIPTION,
  parameters: z.object({}),
  async execute(_params, ctx) {
    const session = await Session.get(ctx.sessionID)
    const plan = path.relative(Instance.worktree, Session.plan(session))

    const workflowConfig = await resolveConfig()
    const nextWorkflow = mergeState(session.workflow, workflowConfig)
    nextWorkflow.mode = nextWorkflow.mode ?? workflowConfig.mode
    const planPath = Session.plan(session)
    const { seeded } = await ensurePlanSeed(planPath)
    nextWorkflow.plan = {
      ...nextWorkflow.plan,
      required: true,
      approved: false,
      lastPlanPath: planPath,
    }
    await Session.update(session.id, (draft) => {
      draft.workflow = nextWorkflow
    })

    return {
      title: "Plan required",
      output: seeded
        ? `Plan required. Draft plan created at ${plan}. Fill it in and run plan_exit to approve.`
        : `Plan required. Create or update the plan at ${plan}. When ready, run plan_exit to approve.`,
      metadata: {},
    }
  },
})
