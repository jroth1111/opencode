export interface TaskRunSummary {
  status?: string
  startedAt?: string | number | null
  summary?: string | null
  budgets?: {
    maxChildren?: number
    maxDepth?: number
    maxOps?: number
  }
  counters?: {
    childrenCreated?: number
    depthRemaining?: number
    opsUsed?: number
  }
}

export function formatTaskRunLine(run: TaskRunSummary): string {
  const parts: string[] = []
  const status = typeof run.status === "string" && run.status.length ? run.status : "unknown"
  parts.push(status)

  if (run.startedAt) {
    parts.push(String(run.startedAt))
  }

  if (run.summary) {
    parts.push(run.summary)
  }

  if (run.counters && run.budgets) {
    const ops = `${run.counters.opsUsed ?? 0}/${run.budgets.maxOps ?? "?"}`
    const children = `${run.counters.childrenCreated ?? 0}/${run.budgets.maxChildren ?? "?"}`
    const depth = `${run.counters.depthRemaining ?? "?"}/${run.budgets.maxDepth ?? "?"}`
    parts.push(`ops ${ops}`)
    parts.push(`children ${children}`)
    parts.push(`depth ${depth}`)
  }

  return parts.join(" · ")
}
