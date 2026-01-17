import z from "zod"
import path from "path"
import { Tool } from "./tool"
import { Session } from "../session"
import { Instance } from "../project/instance"
import { mergeState, resolveConfig, validatePlanText } from "../session/workflow"
import EXIT_DESCRIPTION from "./plan-exit.txt"
import ENTER_DESCRIPTION from "./plan-enter.txt"

export const PlanExitTool = Tool.define("plan_exit", {
  description: EXIT_DESCRIPTION,
  parameters: z.object({}),
  async execute(_params, ctx) {
    const session = await Session.get(ctx.sessionID)
    const planPath = Session.plan(session)
    const plan = path.relative(Instance.worktree, planPath)
    const workflowConfig = await resolveConfig()
    const planText = await Bun.file(planPath).text().catch(() => "")
    const missing = validatePlanText(planText)
    if (missing.length > 0) {
      throw new Error(`Plan is missing required sections: ${missing.join(", ")}`)
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
      output: `Plan required. Create or update the plan at ${plan}. When ready, run plan_exit to approve.`,
      metadata: {},
    }
  },
})
