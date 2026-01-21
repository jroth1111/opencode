const PREFIX = "opencode:"
const SESSION_PREFIX = `${PREFIX}session:`
const REPO_PREFIX = `${PREFIX}repo:`
const TODO_PREFIX = `${PREFIX}todo:`
const AGENT_PREFIX = `${PREFIX}agent:`
const RUN_PREFIX = `${PREFIX}run:`
const CHECKPOINT_LABEL = `${PREFIX}checkpoint`
const ORPHANED_LABEL = `${PREFIX}orphaned`

function encodeLabel(value: string) {
  return encodeURIComponent(value)
}

function decodeLabel(value: string) {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function buildLabel(prefix: string, value: string) {
  return `${prefix}${encodeLabel(value)}`
}

function extractLabelValue(prefix: string, labels?: string[]) {
  if (!labels) return
  const match = labels.find((label) => label.startsWith(prefix))
  if (!match) return
  return decodeLabel(match.slice(prefix.length))
}

export type TaskExternalRef =
  | { kind: "session"; sessionID: string; todoID: string }
  | { kind: "repo"; repoID: string; todoID: string }

export const TaskLabels = {
  prefixes: {
    session: SESSION_PREFIX,
    repo: REPO_PREFIX,
    todo: TODO_PREFIX,
    agent: AGENT_PREFIX,
    run: RUN_PREFIX,
    checkpoint: CHECKPOINT_LABEL,
    orphaned: ORPHANED_LABEL,
  },
  session(sessionID: string) {
    return buildLabel(SESSION_PREFIX, sessionID)
  },
  repo(repoID: string) {
    return buildLabel(REPO_PREFIX, repoID)
  },
  todo(todoID: string) {
    return buildLabel(TODO_PREFIX, todoID)
  },
  agent(agent?: string) {
    if (!agent) return
    return buildLabel(AGENT_PREFIX, agent)
  },
  run(runId?: string) {
    if (!runId) return
    return buildLabel(RUN_PREFIX, runId)
  },
  orphaned() {
    return ORPHANED_LABEL
  },
  checkpoint() {
    return CHECKPOINT_LABEL
  },
  isCheckpoint(labels?: string[]) {
    return !!labels?.includes(CHECKPOINT_LABEL)
  },
  extractTodoID(labels?: string[]) {
    return extractLabelValue(TODO_PREFIX, labels)
  },
  extractSessionID(labels?: string[]) {
    return extractLabelValue(SESSION_PREFIX, labels)
  },
  extractRepoID(labels?: string[]) {
    return extractLabelValue(REPO_PREFIX, labels)
  },
  extractAgent(labels?: string[]) {
    return extractLabelValue(AGENT_PREFIX, labels)
  },
  extractRunId(labels?: string[]) {
    return extractLabelValue(RUN_PREFIX, labels)
  },
  isRepoLabel(labels?: string[]) {
    return !!TaskLabels.extractRepoID(labels)
  },
  sessionExternalRef(sessionID: string, todoID: string) {
    return `${SESSION_PREFIX}${encodeLabel(sessionID)}:todo:${encodeLabel(todoID)}`
  },
  repoExternalRef(repoID: string, todoID: string) {
    return `${REPO_PREFIX}${encodeLabel(repoID)}:todo:${encodeLabel(todoID)}`
  },
  parseExternalRef(ref?: string | null): TaskExternalRef | undefined {
    if (!ref) return
    if (ref.startsWith(SESSION_PREFIX)) {
      const tail = ref.slice(SESSION_PREFIX.length)
      const [rawSession, marker, rawTodo] = tail.split(":")
      if (!rawSession || marker !== "todo" || !rawTodo) return
      return {
        kind: "session",
        sessionID: decodeLabel(rawSession),
        todoID: decodeLabel(rawTodo),
      }
    }
    if (ref.startsWith(REPO_PREFIX)) {
      const tail = ref.slice(REPO_PREFIX.length)
      const [rawRepo, marker, rawTodo] = tail.split(":")
      if (!rawRepo || marker !== "todo" || !rawTodo) return
      return {
        kind: "repo",
        repoID: decodeLabel(rawRepo),
        todoID: decodeLabel(rawTodo),
      }
    }
    return
  },
}

export function agentLabelsToRemove(labels?: string[], keep?: string) {
  if (!labels) return []
  return labels.filter((label) => label.startsWith(AGENT_PREFIX) && label !== keep)
}

export function filterUserLabels(labels?: string[]) {
  if (!labels) return []
  return labels.filter((label) => !label.startsWith(PREFIX))
}

export function uniqueLabels(labels: Array<string | undefined>) {
  return Array.from(new Set(labels.filter(Boolean) as string[]))
}
