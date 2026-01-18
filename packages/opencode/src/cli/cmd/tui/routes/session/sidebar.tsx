import { useSync } from "@tui/context/sync"
import { createEffect, createMemo, createSignal, For, Match, Show, Switch } from "solid-js"
import { createStore } from "solid-js/store"
import { useTheme } from "../../context/theme"
import { Locale } from "@/util/locale"
import path from "path"
import type { AssistantMessage } from "@opencode-ai/sdk/v2"
import { Global } from "@/global"
import { Installation } from "@/installation"
import { useKeybind } from "../../context/keybind"
import { useDirectory } from "../../context/directory"
import { useKV } from "../../context/kv"
import { TodoItem } from "../../component/todo-item"
import { Task } from "@/task"
import { TaskMetrics } from "@/task/metrics"
import { useSDK } from "@tui/context/sdk"
import { useLocal } from "@tui/context/local"

export function Sidebar(props: { sessionID: string; overlay?: boolean }) {
  const sync = useSync()
  const { theme } = useTheme()
  const session = createMemo(() => sync.session.get(props.sessionID)!)
  const diff = createMemo(() => sync.data.session_diff[props.sessionID] ?? [])
  const todo = createMemo(() => sync.data.todo[props.sessionID] ?? [])
  const messages = createMemo(() => sync.data.message[props.sessionID] ?? [])
  const sdk = useSDK()
  const local = useLocal()

  const [expanded, setExpanded] = createStore({
    mcp: true,
    diff: true,
    todo: true,
    lsp: true,
  })

  // Sort MCP servers alphabetically for consistent display order
  const mcpEntries = createMemo(() => Object.entries(sync.data.mcp).sort(([a], [b]) => a.localeCompare(b)))

  // Count connected and error MCP servers for collapsed header display
  const connectedMcpCount = createMemo(() => mcpEntries().filter(([_, item]) => item.status === "connected").length)
  const errorMcpCount = createMemo(
    () =>
      mcpEntries().filter(
        ([_, item]) =>
          item.status === "failed" || item.status === "needs_auth" || item.status === "needs_client_registration",
      ).length,
  )

  const cost = createMemo(() => {
    const total = messages().reduce((sum, x) => sum + (x.role === "assistant" ? x.cost : 0), 0)
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
    }).format(total)
  })

  const context = createMemo(() => {
    const last = messages().findLast((x) => x.role === "assistant" && x.tokens.output > 0) as AssistantMessage
    if (!last) return
    const total =
      last.tokens.input + last.tokens.output + last.tokens.reasoning + last.tokens.cache.read + last.tokens.cache.write
    const model = sync.data.provider.find((x) => x.id === last.providerID)?.models[last.modelID]
    return {
      tokens: total.toLocaleString(),
      percentage: model?.limit.context ? Math.round((total / model.limit.context) * 100) : null,
    }
  })

  const directory = useDirectory()
  const kv = useKV()
  const [todoLane, setTodoLane] = kv.signal<"session" | "repo" | "ready">("todo_lane", "session")
  const [repoTodos, setRepoTodos] = createSignal<Task.Info[]>([])
  const [readyTodos, setReadyTodos] = createSignal<Task.Info[]>([])
  const [laneLoading, setLaneLoading] = createSignal(false)
  const currentAgent = createMemo(() => local.agent.current().name)
  type RawRequestClient = {
    request: (options: { url: string; responseStyle?: "data" | "fields"; query?: Record<string, unknown> }) => Promise<
      unknown
    >
  }
  const rawClient = () => (sdk.client as unknown as { client: RawRequestClient }).client

  const hasProviders = createMemo(() =>
    sync.data.provider.some((x) => x.id !== "opencode" || Object.values(x.models).some((y) => y.cost?.input !== 0)),
  )
  const gettingStartedDismissed = createMemo(() => kv.get("dismissed_getting_started", false))

  const laneTodos = createMemo(() => {
    const lane = todoLane()
    if (lane === "repo") return repoTodos()
    if (lane === "ready") return readyTodos()
    return todo()
  })

  const laneTasks = createMemo(() => laneTodos().map((item) => Task.normalize(item as Task.Info)))

  const visibleTodos = createMemo(() => {
    const items = laneTasks()
    if (todoLane() === "session") return items.filter((item) => Task.isBlockingStatus(item.status))
    if (todoLane() === "ready") return items.filter((item) => Task.normalizeStatus(item.status) !== "draft")
    return items
  })

  const laneSummary = createMemo(() => TaskMetrics.summarizeTodos(laneTasks()))
  const summaryLabel = createMemo(() => {
    const summary = laneSummary()
    if (!summary.total) return ""
    const parts: string[] = []
    if (summary.ready > 0) parts.push(`${summary.ready} ready`)
    if (summary.blocking > 0) parts.push(`${summary.blocking} blocking`)
    if (summary.missingSpec > 0) parts.push(`${summary.missingSpec} spec`)
    return parts.join(", ")
  })

  const laneMap = createMemo(() => {
    const items = laneTasks()
    return new Map(items.map((item) => [item.id, item]))
  })

  const blockedByDeps = (item: Task.Info) => {
    if (todoLane() === "ready") return false
    const deps = item.dependsOn ?? []
    if (deps.length === 0) return false
    const map = laneMap()
    return deps.some((id) => {
      const dep = map.get(id)
      if (!dep) return true
      return !Task.isDoneStatus(dep.status)
    })
  }

  const cycleLane = () => {
    const lanes: Array<"session" | "repo" | "ready"> = ["session", "repo", "ready"]
    const next = lanes[(lanes.indexOf(todoLane()) + 1) % lanes.length]
    setTodoLane(() => next)
  }

  createEffect(() => {
    const lane = todoLane()
    if (lane === "session") return
    const agent = currentAgent()
    setLaneLoading(true)
    rawClient()
      .request({
        url: "/todo",
        responseStyle: "data",
        query: {
          lane,
          agent,
        },
      })
      .then((data: unknown) => {
        const items = (data ?? []) as Task.Info[]
        if (lane === "repo") {
          setRepoTodos(items)
        } else {
          setReadyTodos(items)
        }
      })
      .catch(() => {
        if (lane === "repo") {
          setRepoTodos([])
        } else {
          setReadyTodos([])
        }
      })
      .finally(() => {
        setLaneLoading(false)
      })
  })

  return (
    <Show when={session()}>
      <box
        backgroundColor={theme.backgroundPanel}
        width={42}
        paddingTop={1}
        paddingBottom={1}
        paddingLeft={2}
        paddingRight={2}
        position={props.overlay ? "absolute" : "relative"}
      >
        <scrollbox flexGrow={1}>
          <box flexShrink={0} gap={1} paddingRight={1}>
            <box paddingRight={1}>
              <text fg={theme.text}>
                <b>{session().title}</b>
              </text>
              <Show when={session().share?.url}>
                <text fg={theme.textMuted}>{session().share!.url}</text>
              </Show>
            </box>
            <box>
              <text fg={theme.text}>
                <b>Context</b>
              </text>
              <text fg={theme.textMuted}>{context()?.tokens ?? 0} tokens</text>
              <text fg={theme.textMuted}>{context()?.percentage ?? 0}% used</text>
              <text fg={theme.textMuted}>{cost()} spent</text>
            </box>
            <Show when={mcpEntries().length > 0}>
              <box>
                <box
                  flexDirection="row"
                  gap={1}
                  onMouseDown={() => mcpEntries().length > 2 && setExpanded("mcp", !expanded.mcp)}
                >
                  <Show when={mcpEntries().length > 2}>
                    <text fg={theme.text}>{expanded.mcp ? "▼" : "▶"}</text>
                  </Show>
                  <text fg={theme.text}>
                    <b>MCP</b>
                    <Show when={!expanded.mcp}>
                      <span style={{ fg: theme.textMuted }}>
                        {" "}
                        ({connectedMcpCount()} active
                        {errorMcpCount() > 0 ? `, ${errorMcpCount()} error${errorMcpCount() > 1 ? "s" : ""}` : ""})
                      </span>
                    </Show>
                  </text>
                </box>
                <Show when={mcpEntries().length <= 2 || expanded.mcp}>
                  <For each={mcpEntries()}>
                    {([key, item]) => (
                      <box flexDirection="row" gap={1}>
                        <text
                          flexShrink={0}
                          style={{
                            fg: (
                              {
                                connected: theme.success,
                                failed: theme.error,
                                disabled: theme.textMuted,
                                needs_auth: theme.warning,
                                needs_client_registration: theme.error,
                              } as Record<string, typeof theme.success>
                            )[item.status],
                          }}
                        >
                          •
                        </text>
                        <text fg={theme.text} wrapMode="word">
                          {key}{" "}
                          <span style={{ fg: theme.textMuted }}>
                            <Switch fallback={item.status}>
                              <Match when={item.status === "connected"}>Connected</Match>
                              <Match when={item.status === "failed" && item}>{(val) => <i>{val().error}</i>}</Match>
                              <Match when={item.status === "disabled"}>Disabled</Match>
                              <Match when={(item.status as string) === "needs_auth"}>Needs auth</Match>
                              <Match when={(item.status as string) === "needs_client_registration"}>
                                Needs client ID
                              </Match>
                            </Switch>
                          </span>
                        </text>
                      </box>
                    )}
                  </For>
                </Show>
              </box>
            </Show>
            <box>
              <box
                flexDirection="row"
                gap={1}
                onMouseDown={() => sync.data.lsp.length > 2 && setExpanded("lsp", !expanded.lsp)}
              >
                <Show when={sync.data.lsp.length > 2}>
                  <text fg={theme.text}>{expanded.lsp ? "▼" : "▶"}</text>
                </Show>
                <text fg={theme.text}>
                  <b>LSP</b>
                </text>
              </box>
              <Show when={sync.data.lsp.length <= 2 || expanded.lsp}>
                <Show when={sync.data.lsp.length === 0}>
                  <text fg={theme.textMuted}>
                    {sync.data.config.lsp === false
                      ? "LSPs have been disabled in settings"
                      : "LSPs will activate as files are read"}
                  </text>
                </Show>
                <For each={sync.data.lsp}>
                  {(item) => (
                    <box flexDirection="row" gap={1}>
                      <text
                        flexShrink={0}
                        style={{
                          fg: {
                            connected: theme.success,
                            error: theme.error,
                          }[item.status],
                        }}
                      >
                        •
                      </text>
                      <text fg={theme.textMuted}>
                        {item.id} {item.root}
                      </text>
                    </box>
                  )}
                </For>
              </Show>
            </box>
            <box>
              <box
                flexDirection="row"
                gap={1}
                onMouseDown={() => {
                  if (visibleTodos().length > 2) setExpanded("todo", !expanded.todo)
                }}
              >
                <Show when={visibleTodos().length > 2}>
                  <text fg={theme.text}>{expanded.todo ? "▼" : "▶"}</text>
                </Show>
                <box flexDirection="row" gap={1}>
                  <text fg={theme.text}>
                    <b>Todo</b>
                  </text>
                  <text fg={theme.textMuted} onMouseDown={cycleLane}>
                    ({todoLane()}
                    {laneLoading() ? ", loading" : ""}
                    {summaryLabel() ? ` • ${summaryLabel()}` : ""})
                  </text>
                </box>
              </box>
              <Show
                when={visibleTodos().length > 0}
                fallback={<text fg={theme.textMuted}>No {todoLane()} todos</text>}
              >
                <Show when={visibleTodos().length <= 2 || expanded.todo}>
                  <For each={visibleTodos()}>
                    {(todo) => (
                      <TodoItem
                        status={todo.status}
                        content={todo.content}
                        dependsOn={todo.dependsOn}
                        blocks={todo.blocks}
                        missingSpec={Task.missingSpec(todo)}
                        specComplete={Task.isSpecComplete(todo)}
                        blockedByDeps={blockedByDeps(todo)}
                        ready={todoLane() === "ready"}
                      />
                    )}
                  </For>
                </Show>
              </Show>
            </box>
            <Show when={diff().length > 0}>
              <box>
                <box
                  flexDirection="row"
                  gap={1}
                  onMouseDown={() => diff().length > 2 && setExpanded("diff", !expanded.diff)}
                >
                  <Show when={diff().length > 2}>
                    <text fg={theme.text}>{expanded.diff ? "▼" : "▶"}</text>
                  </Show>
                  <text fg={theme.text}>
                    <b>Modified Files</b>
                  </text>
                </box>
                <Show when={diff().length <= 2 || expanded.diff}>
                  <For each={diff() || []}>
                    {(item) => {
                      const file = createMemo(() => {
                        const splits = item.file.split(path.sep).filter(Boolean)
                        const last = splits.at(-1)!
                        const rest = splits.slice(0, -1).join(path.sep)
                        if (!rest) return last
                        return Locale.truncateMiddle(rest, 30 - last.length) + "/" + last
                      })
                      return (
                        <box flexDirection="row" gap={1} justifyContent="space-between">
                          <text fg={theme.textMuted} wrapMode="char">
                            {file()}
                          </text>
                          <box flexDirection="row" gap={1} flexShrink={0}>
                            <Show when={item.additions}>
                              <text fg={theme.diffAdded}>+{item.additions}</text>
                            </Show>
                            <Show when={item.deletions}>
                              <text fg={theme.diffRemoved}>-{item.deletions}</text>
                            </Show>
                          </box>
                        </box>
                      )
                    }}
                  </For>
                </Show>
              </box>
            </Show>
          </box>
        </scrollbox>

        <box flexShrink={0} gap={1} paddingTop={1}>
          <Show when={!hasProviders() && !gettingStartedDismissed()}>
            <box
              backgroundColor={theme.backgroundElement}
              paddingTop={1}
              paddingBottom={1}
              paddingLeft={2}
              paddingRight={2}
              flexDirection="row"
              gap={1}
            >
              <text flexShrink={0} fg={theme.text}>
                ⬖
              </text>
              <box flexGrow={1} gap={1}>
                <box flexDirection="row" justifyContent="space-between">
                  <text fg={theme.text}>
                    <b>Getting started</b>
                  </text>
                  <text fg={theme.textMuted} onMouseDown={() => kv.set("dismissed_getting_started", true)}>
                    ✕
                  </text>
                </box>
                <text fg={theme.textMuted}>OpenCode includes free models so you can start immediately.</text>
                <text fg={theme.textMuted}>
                  Connect from 75+ providers to use other models, including Claude, GPT, Gemini etc
                </text>
                <box flexDirection="row" gap={1} justifyContent="space-between">
                  <text fg={theme.text}>Connect provider</text>
                  <text fg={theme.textMuted}>/connect</text>
                </box>
              </box>
            </box>
          </Show>
          <text>
            <span style={{ fg: theme.textMuted }}>{directory().split("/").slice(0, -1).join("/")}/</span>
            <span style={{ fg: theme.text }}>{directory().split("/").at(-1)}</span>
          </text>
          <text fg={theme.textMuted}>
            <span style={{ fg: theme.success }}>•</span> <b>Open</b>
            <span style={{ fg: theme.text }}>
              <b>Code</b>
            </span>{" "}
            <span>{Installation.VERSION}</span>
          </text>
        </box>
      </box>
    </Show>
  )
}
