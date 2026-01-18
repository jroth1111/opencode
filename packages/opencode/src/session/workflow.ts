import { Config } from "@/config/config"
import { Flag } from "@/flag/flag"

export type WorkflowMode = "minimal" | "workflow"
export type WorkflowTrack = "fast" | "full"
export type WorkflowPlanMode = "auto" | "always" | "off"
export type GateEnforcement = "soft" | "hard"

export type WorkflowConfig = {
  mode: WorkflowMode
  kickoff: {
    attach: boolean
  }
  plan: {
    mode: WorkflowPlanMode
    keywords: string[]
    minPromptChars: number
  }
  verify: {
    afterEdit: boolean
    commands: string[]
  }
  nudge: {
    enabled: boolean
    minPromptChars: number
    keywords: string[]
    maxEdits: number
    maxFiles: number
    maxBlockingTodos: number
    dependencyPatterns: string[]
    scaffoldCommands: string[]
  }
}

export type WorkflowPolicy = {
  kickoff: GateEnforcement
  plan: GateEnforcement
  verify: GateEnforcement
  drift: GateEnforcement
}

export type WorkflowKickoff = {
  intent?: string
  scope?: string
  risk?: "low" | "medium" | "high"
  definitionOfDone?: string
  acceptance?: string[]
  webSearchGate?: {
    q1ExternalTruth?: boolean
    q2VersionedFact?: boolean
    q3UnexplainedFailure?: boolean
    q4SecurityBoundary?: boolean
    q5HighCostDecision?: boolean
    references?: string[]
    versions?: string[]
  }
  track?: WorkflowTrack
}

export type WorkflowNudgeSignals = {
  promptChars?: number
  keywordHit?: string
  edits?: number
  filesTouched?: number
  dependencyTouched?: boolean
  scaffoldCommand?: string
  blockingTodos?: number
}

export type WorkflowNudge = {
  suggested?: boolean
  suggestedAt?: number
  dismissed?: boolean
  reason?: string
  signals?: WorkflowNudgeSignals
}

export type WorkflowState = {
  mode?: WorkflowMode
  kickoff?: WorkflowKickoff
  nudge?: WorkflowNudge
  plan?: {
    required?: boolean
    approved?: boolean
    lastPlanPath?: string
    lastPlanUpdatedAt?: number
  }
  verify?: {
    required?: boolean
    lastVerifiedAt?: number
    lastCommand?: string
    lastExitCode?: number
  }
  drift?: {
    active?: boolean
    lastReason?: string
    decision?: "fix_code" | "update_spec" | "abort"
    lastDecisionAt?: number
  }
}

type LegacyWorkflowState = {
  planRequired?: boolean
  planApproved?: boolean
  verifyRequired?: boolean
  lastVerifiedAt?: number
  track?: WorkflowTrack
  entry?: {
    intent?: string
    constraints?: string
    verification?: string
    mode?: WorkflowMode
    riskGate?: {
      q1ExternalTruth?: boolean
      q2VersionedFact?: boolean
      q3UnexplainedFailure?: boolean
      q4SecurityBoundary?: boolean
      q5HighCostDecision?: boolean
    }
  }
  triage?: WorkflowKickoff
}

const DEFAULT_KEYWORDS = [
  "refactor",
  "migrate",
  "migration",
  "auth",
  "authentication",
  "billing",
  "payment",
  "deploy",
  "deployment",
  "schema",
  "api",
  "security",
  "performance",
  "database",
  "infra",
]

const DEFAULT_MIN_PROMPT_CHARS = 240
const DEFAULT_KICKOFF_ATTACH = false
const DEFAULT_VERIFY_COMMANDS = ["\\btest\\b", "\\blint\\b", "\\btypecheck\\b", "\\bcheck\\b", "\\bci\\b", "\\bverify\\b"]
const DEFAULT_NUDGE_MIN_PROMPT_CHARS = 240
const DEFAULT_NUDGE_MAX_EDITS = 3
const DEFAULT_NUDGE_MAX_FILES = 3
const DEFAULT_NUDGE_MAX_BLOCKING_TODOS = 5
const DEFAULT_DEPENDENCY_PATTERNS = [
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  "pyproject.toml",
  "requirements.txt",
  "Cargo.toml",
  "go.mod",
  "Gemfile",
  "composer.json",
  "schema.prisma",
]
const DEFAULT_SCAFFOLD_COMMANDS = [
  "\\b(npx|pnpm|npm|bunx)\\s+create\\b",
  "\\b(npm|pnpm|yarn|bun)\\s+init\\b",
  "\\bcreate-\\w+\\b",
  "\\bexpo\\s+init\\b",
  "\\brails\\s+new\\b",
  "\\bcargo\\s+new\\b",
]

const VALID_MODES = new Set<WorkflowMode>(["minimal", "workflow"])

export class PlanRequiredError extends Error {
  constructor() {
    super("Plan required before edits. Use plan_enter to create an approved plan.")
  }
}

export class VerifyRequiredError extends Error {
  constructor() {
    super("Verification required before further edits. Run tests/lint/typecheck or other verification commands.")
  }
}

export class KickoffRequiredError extends Error {
  constructor() {
    super("Workflow kickoff required before edits. Use kickoff to capture scope, risk, and acceptance.")
  }
}

export async function resolveConfig(): Promise<WorkflowConfig> {
  const cfg = await Config.get()

  let mode: WorkflowMode = cfg.workflow?.mode ?? "minimal"

  const envMode = Flag.OPENCODE_WORKFLOW_MODE
  if (envMode && VALID_MODES.has(envMode as WorkflowMode)) {
    mode = envMode as WorkflowMode
  }

  const planMode: WorkflowPlanMode = cfg.workflow?.plan?.mode ?? (mode === "workflow" ? "always" : "off")
  const keywords = cfg.workflow?.plan?.keywords ?? DEFAULT_KEYWORDS
  const minPromptChars = cfg.workflow?.plan?.min_prompt_chars ?? DEFAULT_MIN_PROMPT_CHARS
  const kickoffAttach = cfg.workflow?.kickoff?.attach ?? DEFAULT_KICKOFF_ATTACH

  const verifyAfterEdit = cfg.workflow?.verify?.after_edit ?? true
  const verifyCommands = cfg.workflow?.verify?.commands ?? DEFAULT_VERIFY_COMMANDS

  const nudge = cfg.workflow?.nudge
  const nudgeEnabled = nudge?.enabled ?? true
  const nudgeMinPromptChars = nudge?.min_prompt_chars ?? DEFAULT_NUDGE_MIN_PROMPT_CHARS
  const nudgeKeywords = nudge?.keywords ?? DEFAULT_KEYWORDS
  const nudgeMaxEdits = nudge?.max_edits ?? DEFAULT_NUDGE_MAX_EDITS
  const nudgeMaxFiles = nudge?.max_files ?? DEFAULT_NUDGE_MAX_FILES
  const nudgeMaxBlockingTodos = nudge?.max_blocking_todos ?? DEFAULT_NUDGE_MAX_BLOCKING_TODOS
  const nudgeDependencyPatterns = nudge?.dependency_patterns ?? DEFAULT_DEPENDENCY_PATTERNS
  const nudgeScaffoldCommands = nudge?.scaffold_commands ?? DEFAULT_SCAFFOLD_COMMANDS

  return {
    mode,
    kickoff: {
      attach: kickoffAttach,
    },
    plan: {
      mode: planMode,
      keywords,
      minPromptChars,
    },
    verify: {
      afterEdit: verifyAfterEdit,
      commands: verifyCommands,
    },
    nudge: {
      enabled: nudgeEnabled,
      minPromptChars: nudgeMinPromptChars,
      keywords: nudgeKeywords,
      maxEdits: nudgeMaxEdits,
      maxFiles: nudgeMaxFiles,
      maxBlockingTodos: nudgeMaxBlockingTodos,
      dependencyPatterns: nudgeDependencyPatterns,
      scaffoldCommands: nudgeScaffoldCommands,
    },
  }
}

export function policyFor(config: WorkflowConfig): WorkflowPolicy {
  const enforcement: GateEnforcement = config.mode === "workflow" ? "hard" : "soft"
  return {
    kickoff: "hard",
    plan: enforcement,
    verify: enforcement,
    drift: enforcement,
  }
}

export function planModeFor(config: WorkflowConfig, mode: WorkflowMode): WorkflowPlanMode {
  if (mode === "minimal") return "off"
  return config.plan.mode
}

function kickoffFromLegacy(state: LegacyWorkflowState | undefined): WorkflowKickoff | undefined {
  if (!state) return
  const entry = state.entry
  const triage = state.triage
  if (!entry && !triage) return
  return {
    intent: entry?.intent ?? triage?.intent,
    scope: triage?.scope,
    risk: triage?.risk,
    definitionOfDone: triage?.definitionOfDone,
    acceptance: triage?.acceptance,
    webSearchGate: triage?.webSearchGate,
    track: triage?.track ?? state.track,
  }
}

function normalizeLegacy(state: WorkflowState | LegacyWorkflowState | undefined, config: WorkflowConfig): WorkflowState {
  if (!state) return { mode: config.mode }
  const legacy = state as LegacyWorkflowState
  const mode = (state as WorkflowState).mode ?? config.mode
  const track = (state as WorkflowState).kickoff?.track ?? legacy.track
  return {
    mode,
    kickoff: (state as WorkflowState).kickoff ?? kickoffFromLegacy(legacy),
    nudge: (state as WorkflowState).nudge,
    plan: {
      required: (state as WorkflowState).plan?.required ?? legacy.planRequired,
      approved: (state as WorkflowState).plan?.approved ?? legacy.planApproved,
      lastPlanPath: (state as WorkflowState).plan?.lastPlanPath,
      lastPlanUpdatedAt: (state as WorkflowState).plan?.lastPlanUpdatedAt,
    },
    verify: {
      required: (state as WorkflowState).verify?.required ?? legacy.verifyRequired,
      lastVerifiedAt: (state as WorkflowState).verify?.lastVerifiedAt ?? legacy.lastVerifiedAt,
      lastCommand: (state as WorkflowState).verify?.lastCommand,
      lastExitCode: (state as WorkflowState).verify?.lastExitCode,
    },
    drift: (state as WorkflowState).drift,
  }
}

export function mergeState(state: WorkflowState | LegacyWorkflowState | undefined, config: WorkflowConfig): WorkflowState {
  const normalized = normalizeLegacy(state, config)
  return {
    mode: normalized.mode ?? config.mode,
    kickoff: normalized.kickoff,
    nudge: normalized.nudge,
    plan: {
      required: normalized.plan?.required ?? false,
      approved: normalized.plan?.approved ?? false,
      lastPlanPath: normalized.plan?.lastPlanPath,
      lastPlanUpdatedAt: normalized.plan?.lastPlanUpdatedAt,
    },
    verify: {
      required: normalized.verify?.required ?? false,
      lastVerifiedAt: normalized.verify?.lastVerifiedAt,
      lastCommand: normalized.verify?.lastCommand,
      lastExitCode: normalized.verify?.lastExitCode,
    },
    drift: {
      active: normalized.drift?.active ?? false,
      lastReason: normalized.drift?.lastReason,
      decision: normalized.drift?.decision,
      lastDecisionAt: normalized.drift?.lastDecisionAt,
    },
  }
}

export function shouldRequirePlan(prompt: string, config: WorkflowConfig, planModeOverride?: WorkflowPlanMode): boolean {
  const planMode = planModeOverride ?? config.plan.mode
  if (planMode === "off") return false
  if (planMode === "always") return true
  const trimmed = prompt.trim()
  if (trimmed.length === 0) return false
  if (trimmed.length >= config.plan.minPromptChars) return true
  const lower = trimmed.toLowerCase()
  return config.plan.keywords.some((keyword) => lower.includes(keyword.toLowerCase()))
}

export function isKickoffComplete(kickoff: WorkflowKickoff | undefined): boolean {
  if (!kickoff) return false
  if (!kickoff.intent) return false
  if (!kickoff.scope) return false
  if (!kickoff.risk) return false
  if (!kickoff.definitionOfDone) return false
  if (!kickoff.acceptance || kickoff.acceptance.length === 0) return false
  if (!kickoff.track) return false
  const gate = kickoff.webSearchGate
  if (!gate) return false
  const answered = [
    gate.q1ExternalTruth,
    gate.q2VersionedFact,
    gate.q3UnexplainedFailure,
    gate.q4SecurityBoundary,
    gate.q5HighCostDecision,
  ].every((item) => typeof item === "boolean")
  return answered
}

export type WebSearchGateStatus = {
  answered: boolean
  required: boolean
  missingReferences: boolean
  missingVersions: boolean
}

export function webSearchGateStatus(kickoff: WorkflowKickoff | undefined): WebSearchGateStatus {
  const gate = kickoff?.webSearchGate
  if (!gate) {
    return {
      answered: false,
      required: false,
      missingReferences: false,
      missingVersions: false,
    }
  }
  const answered = [
    gate.q1ExternalTruth,
    gate.q2VersionedFact,
    gate.q3UnexplainedFailure,
    gate.q4SecurityBoundary,
    gate.q5HighCostDecision,
  ].every((item) => typeof item === "boolean")
  const required = [
    gate.q1ExternalTruth,
    gate.q2VersionedFact,
    gate.q3UnexplainedFailure,
    gate.q4SecurityBoundary,
    gate.q5HighCostDecision,
  ].some((item) => item === true)
  const missingReferences = required && (gate.references?.length ?? 0) === 0
  const missingVersions = required && (gate.versions?.length ?? 0) === 0
  return {
    answered,
    required,
    missingReferences,
    missingVersions,
  }
}

export type PlanSectionSpec = {
  id: string
  label: string
  pattern: RegExp
}

export function requiredPlanSections(): PlanSectionSpec[] {
  return [
    { id: "REQUIREMENTS", label: "Requirements (or Acceptance)", pattern: /\bREQUIREMENTS?\b|\bACCEPTANCE\b/i },
    { id: "PLAN", label: "Plan (or Steps)", pattern: /\bPLAN\b|\bSTEPS?\b/i },
    { id: "VERIFICATION", label: "Verification (or Tests)", pattern: /\bTESTS?\b|\bVERIFY\b|\bVERIFICATION\b/i },
  ]
}

export function validatePlanText(text: string): string[] {
  const sections = requiredPlanSections()
  const missing: string[] = []
  for (const section of sections) {
    if (!section.pattern.test(text)) missing.push(section.id)
  }
  return missing
}

export function describeMissingPlanSections(missing: string[]): string[] {
  const sections = requiredPlanSections()
  const labels = new Map(sections.map((section) => [section.id, section.label]))
  return missing.map((id) => labels.get(id) ?? id)
}

export function isVerificationCommand(command: string, config: WorkflowConfig): boolean {
  if (!command) return false
  const text = command.toLowerCase()
  for (const pattern of config.verify.commands) {
    try {
      const regex = new RegExp(pattern, "i")
      if (regex.test(command)) return true
    } catch {
      if (text.includes(pattern.toLowerCase())) return true
    }
  }
  return false
}

const FINISH_INTENT_PHRASES = new Set([
  "done",
  "finish",
  "finished",
  "all done",
  "all set",
  "that's all",
  "that is all",
  "wrap up",
  "wrap it up",
  "ship it",
  "ship",
  "complete",
  "complete it",
  "close it",
  "close out",
  "exit",
  "quit",
])

export function isFinishIntent(text: string): boolean {
  const trimmed = text.trim()
  if (!trimmed) return false
  if (trimmed.length > 64) return false
  const normalized = trimmed.toLowerCase().replace(/[.!?]+$/g, "").replace(/\s+/g, " ")
  const withoutThanks = normalized.replace(/(,?\s*(thanks|thank you|thx))$/g, "").trim()
  return FINISH_INTENT_PHRASES.has(withoutThanks)
}

function ensureNudge(nudge: WorkflowNudge | undefined): WorkflowNudge {
  return nudge ?? { signals: {} }
}

export function recordNudgeEdit(
  nudge: WorkflowNudge | undefined,
  filePath: string | undefined,
  config: WorkflowConfig,
): WorkflowNudge {
  const next = ensureNudge(nudge)
  const signals = { ...(next.signals ?? {}) }
  signals.edits = (signals.edits ?? 0) + 1
  if (filePath) {
    const filename = filePath.split(/[/\\\\]/).pop()?.toLowerCase()
    const touched = signals.filesTouched ?? 0
    signals.filesTouched = touched + 1
    if (filename && config.nudge.dependencyPatterns.some((pattern) => pattern.toLowerCase() === filename)) {
      signals.dependencyTouched = true
    }
  }
  return { ...next, signals }
}

export function recordNudgeCommand(
  nudge: WorkflowNudge | undefined,
  command: string | undefined,
  config: WorkflowConfig,
): WorkflowNudge {
  if (!command) return nudge ?? { signals: {} }
  const next = ensureNudge(nudge)
  const signals = { ...(next.signals ?? {}) }
  for (const pattern of config.nudge.scaffoldCommands) {
    try {
      const regex = new RegExp(pattern, "i")
      if (regex.test(command)) {
        signals.scaffoldCommand = command
        break
      }
    } catch {
      if (command.toLowerCase().includes(pattern.toLowerCase())) {
        signals.scaffoldCommand = command
        break
      }
    }
  }
  return { ...next, signals }
}

export function recordNudgeBlockingTodos(nudge: WorkflowNudge | undefined, blockingCount: number): WorkflowNudge {
  const next = ensureNudge(nudge)
  const signals = { ...(next.signals ?? {}) }
  signals.blockingTodos = blockingCount
  return { ...next, signals }
}

export function evaluateNudge(prompt: string, state: WorkflowState, config: WorkflowConfig): { shouldNudge: boolean; reason?: string; signals?: WorkflowNudgeSignals } {
  if (!config.nudge.enabled) return { shouldNudge: false }
  if (state.mode !== "minimal") return { shouldNudge: false }
  const existing = state.nudge
  if (existing?.dismissed || existing?.suggested) return { shouldNudge: false }

  const trimmed = prompt.trim()
  if (trimmed.length >= config.nudge.minPromptChars) {
    return { shouldNudge: true, reason: "prompt_length", signals: { promptChars: trimmed.length } }
  }

  const lower = trimmed.toLowerCase()
  const keywordHit = config.nudge.keywords.find((keyword) => lower.includes(keyword.toLowerCase()))
  if (keywordHit) {
    return { shouldNudge: true, reason: `keyword:${keywordHit}`, signals: { keywordHit } }
  }

  const signals = existing?.signals
  if ((signals?.edits ?? 0) >= config.nudge.maxEdits) {
    return { shouldNudge: true, reason: "edit_count", signals }
  }
  if ((signals?.filesTouched ?? 0) >= config.nudge.maxFiles) {
    return { shouldNudge: true, reason: "file_count", signals }
  }
  if (signals?.dependencyTouched) {
    return { shouldNudge: true, reason: "dependency_touched", signals }
  }
  if (signals?.scaffoldCommand) {
    return { shouldNudge: true, reason: "scaffold_command", signals }
  }
  if ((signals?.blockingTodos ?? 0) >= config.nudge.maxBlockingTodos) {
    return { shouldNudge: true, reason: "blocking_todos", signals }
  }

  return { shouldNudge: false }
}
