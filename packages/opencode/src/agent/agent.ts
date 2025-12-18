import { Config } from "../config/config"
import z from "zod"
import { Provider } from "../provider/provider"
import { generateObject, type ModelMessage } from "ai"
import { SystemPrompt } from "../session/system"
import { Instance } from "../project/instance"

import PROMPT_GENERATE from "./generate.txt"
import PROMPT_COMPACTION from "./prompt/compaction.txt"
import PROMPT_EXPLORE from "./prompt/explore.txt"
import PROMPT_SUMMARY from "./prompt/summary.txt"
import PROMPT_TITLE from "./prompt/title.txt"
import { PermissionNext } from "@/permission/next"

export namespace Agent {
  export const Info = z
    .object({
      name: z.string(),
      description: z.string().optional(),
      mode: z.enum(["subagent", "primary", "all"]),
      native: z.boolean().optional(),
      hidden: z.boolean().optional(),
      topP: z.number().optional(),
      temperature: z.number().optional(),
      color: z.string().optional(),
      permission: PermissionNext.Ruleset,
      model: z
        .object({
          modelID: z.string(),
          providerID: z.string(),
        })
        .optional(),
      prompt: z.string().optional(),
      options: z.record(z.string(), z.any()),
      steps: z.number().int().positive().optional(),
    })
    .meta({
      ref: "Agent",
    })
  export type Info = z.infer<typeof Info>

  const state = Instance.state(async () => {
    const cfg = await Config.get()
    const defaultTools = cfg.tools ?? {}

    const permission: PermissionNext.Ruleset = PermissionNext.merge(
      {
        edit: {
          "*": "allow",
        },
        bash: {
          "*": "allow",
        },
        webfetch: {
          "*": "allow",
        },
        doom_loop: {
          "*": "ask",
        },
        external_directory: {
          "*": "ask",
        },
      },
      PermissionNext.fromConfig(cfg.permission ?? {}),
    )

    const result: Record<string, Info> = {
      build: {
        name: "build",
        options: {},
        permission,
        mode: "primary",
        native: true,
      },
      plan: {
        name: "plan",
        options: {},
        permission: PermissionNext.merge(permission, {
          edit: {
            "*": "deny",
            ".opencode/plan/*": "allow",
          },
        }),
        mode: "primary",
        native: true,
      },
      general: {
        name: "general",
        description: `General-purpose agent for researching complex questions and executing multi-step tasks. Use this agent to execute multiple units of work in parallel.`,
        permission: PermissionNext.merge(
          permission,
          PermissionNext.fromConfig({
            todoread: "deny",
            todowrite: "deny",
          }),
        ),
        options: {},
        mode: "subagent",
        native: true,
        hidden: true,
      },
      explore: {
        name: "explore",
        permission: PermissionNext.merge(
          permission,
          PermissionNext.fromConfig({
            todoread: "deny",
            todowrite: "deny",
            edit: "deny",
            write: "deny",
          }),
        ),
        description: `Fast agent specialized for exploring codebases. Use this when you need to quickly find files by patterns (eg. "src/components/**/*.tsx"), search code for keywords (eg. "API endpoints"), or answer questions about the codebase (eg. "how do API endpoints work?"). When calling this agent, specify the desired thoroughness level: "quick" for basic searches, "medium" for moderate exploration, or "very thorough" for comprehensive analysis across multiple locations and naming conventions.`,
        prompt: PROMPT_EXPLORE,
        options: {},
        mode: "subagent",
        native: true,
      },
      compaction: {
        name: "compaction",
        mode: "primary",
        native: true,
        hidden: true,
        prompt: PROMPT_COMPACTION,
        permission: PermissionNext.fromConfig({
          "*": "deny",
        }),
        options: {},
      },
      title: {
        name: "title",
        mode: "primary",
        options: {},
        native: true,
        hidden: true,
        permission: PermissionNext.fromConfig({
          "*": "deny",
        }),
        prompt: PROMPT_TITLE,
      },
      summary: {
        name: "summary",
        mode: "primary",
        options: {},
        native: true,
        hidden: true,
        permission: PermissionNext.fromConfig({
          "*": "deny",
        }),
        prompt: PROMPT_SUMMARY,
      },
    }

    for (const [key, value] of Object.entries(cfg.agent ?? {})) {
      if (value.disable) {
        delete result[key]
        continue
      }
      let item = result[key]
      if (!item)
        item = result[key] = {
          name: key,
          mode: "all",
          permission: permission,
          options: {},
          native: false,
        }
      const {
        name,
        model,
        prompt,
        tools,
        description,
        temperature,
        top_p,
        mode,
        permission,
        color,
        maxSteps,
        ...extra
      } = value
      item.options = {
        ...item.options,
        ...extra,
      }
      if (model) item.model = Provider.parseModel(model)
      if (prompt) item.prompt = prompt
      if (tools)
        item.tools = {
          ...item.tools,
          ...tools,
        }
      item.tools = {
        ...defaultTools,
        ...item.tools,
      }
      if (description) item.description = description
      if (temperature != undefined) item.temperature = temperature
      if (top_p != undefined) item.topP = top_p
      if (mode) item.mode = mode
      if (color) item.color = color
      // just here for consistency & to prevent it from being added as an option
      if (name) item.name = name
      if (maxSteps != undefined) item.steps = maxSteps

      if (permission ?? cfg.permission) {
        item.permission = mergeAgentPermissions(cfg.permission ?? {}, permission ?? {})
      }
    }
    return result
  })

  export async function get(agent: string) {
    return state().then((x) => x[agent])
  }

  export async function list() {
    return state().then((x) => Object.values(x))
  }

  export async function generate(input: { description: string; model?: { providerID: string; modelID: string } }) {
    const cfg = await Config.get()
    const defaultModel = input.model ?? (await Provider.defaultModel())
    const model = await Provider.getModel(defaultModel.providerID, defaultModel.modelID)
    const language = await Provider.getLanguage(model)
    const system = SystemPrompt.header(defaultModel.providerID)
    system.push(PROMPT_GENERATE)
    const existing = await list()
    const result = await generateObject({
      experimental_telemetry: {
        isEnabled: cfg.experimental?.openTelemetry,
        metadata: {
          userId: cfg.username ?? "unknown",
        },
      },
      temperature: 0.3,
      messages: [
        ...system.map(
          (item): ModelMessage => ({
            role: "system",
            content: item,
          }),
        ),
        {
          role: "user",
          content: `Create an agent configuration based on this request: \"${input.description}\".\n\nIMPORTANT: The following identifiers already exist and must NOT be used: ${existing.map((i) => i.name).join(", ")}\n  Return ONLY the JSON object, no other text, do not wrap in backticks`,
        },
      ],
      model: language,
      schema: z.object({
        identifier: z.string(),
        whenToUse: z.string(),
        systemPrompt: z.string(),
      }),
    })
    return result.object
  }
}

function mergeAgentPermissions(basePermission: any, overridePermission: any): Agent.Info["permission"] {
  if (typeof basePermission.bash === "string") {
    basePermission.bash = {
      "*": basePermission.bash,
    }
  }
  if (typeof overridePermission.bash === "string") {
    overridePermission.bash = {
      "*": overridePermission.bash,
    }
  }
  const merged = mergeDeep(basePermission ?? {}, overridePermission ?? {}) as any
  let mergedBash
  if (merged.bash) {
    if (typeof merged.bash === "string") {
      mergedBash = {
        "*": merged.bash,
      }
    } else if (typeof merged.bash === "object") {
      mergedBash = mergeDeep(
        {
          "*": "allow",
        },
        merged.bash,
      )
    }
  }

  const result: Agent.Info["permission"] = {
    edit: merged.edit ?? "allow",
    webfetch: merged.webfetch ?? "allow",
    bash: mergedBash ?? { "*": "allow" },
    doom_loop: merged.doom_loop,
    external_directory: merged.external_directory,
  }

  return result
}
