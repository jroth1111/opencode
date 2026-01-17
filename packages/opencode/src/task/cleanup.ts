import { TaskRun } from "@/task/run"
import { Todo } from "@/session/todo"
import { RepoTodo } from "@/task/repo"

export type CleanupMode = "close" | "archive"

export async function cleanupDraftChildren(runId: string, options?: { mode?: CleanupMode }) {
  const run = await TaskRun.get(runId)
  if (!run) return
  if (run.status === "completed") {
    if (run.todoLane === "repo") {
      await RepoTodo.promoteDraftChildren({ sessionID: run.sessionId, runId }).catch(() => {})
      return
    }
    const sessionID = run.todoSessionId ?? run.sessionId
    await Todo.promoteDraftChildren({ sessionID, runId }).catch(() => {})
    return
  }
  const mode = options?.mode === "archive" ? "archive" : "close"
  if (run.todoLane === "repo") {
    await RepoTodo.cleanupDraftChildren({ sessionID: run.sessionId, runId, mode }).catch(() => {})
    return
  }
  const sessionID = run.todoSessionId ?? run.sessionId
  await Todo.cleanupDraftChildren({ sessionID, runId, mode }).catch(() => {})
}
