import { type Accessor, createMemo, createSignal, Match, Show, Switch } from "solid-js"
import { useRouteData } from "@tui/context/route"
import { useSync } from "@tui/context/sync"
import { pipe, sumBy } from "remeda"
import { useTheme } from "@tui/context/theme"
import { SplitBorder } from "@tui/component/border"
import type { AssistantMessage, Session } from "@opencode-ai/sdk/v2"
import { useCommandDialog } from "@tui/component/dialog-command"
import { useKeybind } from "../../context/keybind"
import { useKV } from "../../context/kv"
import { isKickoffComplete, webSearchGateStatus } from "@/session/workflow"
import { Task } from "@/task"
import { Locale } from "@/util/locale"

const Title = (props: { session: Accessor<Session> }) => {
  const { theme } = useTheme()
  return (
    <text fg={theme.text}>
      <span style={{ bold: true }}>#</span> <span style={{ bold: true }}>{props.session().title}</span>
    </text>
  )
}

const ContextInfo = (props: { context: Accessor<string | undefined>; cost: Accessor<string> }) => {
  const { theme } = useTheme()
  return (
    <Show when={props.context()}>
      <text fg={theme.textMuted} wrapMode="none" flexShrink={0}>
        {props.context()} ({props.cost()})
      </text>
    </Show>
  )
}

export function Header() {
  const route = useRouteData("session")
  const sync = useSync()
  const kv = useKV()
  const session = createMemo(() => sync.session.get(route.sessionID)!)
  const messages = createMemo(() => sync.data.message[route.sessionID] ?? [])
  const workflow = createMemo(() => (session() as any)?.workflow)
  const mode = createMemo(() => {
    const wf = workflow()
    return wf?.mode as "minimal" | "workflow" | undefined
  })
  const track = createMemo(() => workflow()?.kickoff?.track as "fast" | "full" | undefined)
  const kickoffRequired = createMemo(() => mode() === "workflow" && !isKickoffComplete(workflow()?.kickoff))
  const planRequired = createMemo(() => workflow()?.plan?.required && !workflow()?.plan?.approved)
  const verifyRequired = createMemo(() => workflow()?.verify?.required)
  const nudgeSuggested = createMemo(() => mode() === "minimal" && workflow()?.nudge?.suggested && !workflow()?.nudge?.dismissed)
  const [todoLane] = kv.signal<"session" | "repo" | "ready">("todo_lane", "session")
  const todos = createMemo(() => sync.data.todo[route.sessionID] ?? [])
  const focusedTodo = createMemo(() => {
    const lane = todoLane()
    if (lane !== "session") {
      return (kv.get("focused_todo") as Task.Info | null | undefined) ?? undefined
    }
    return Task.pickFocused(todos() as Task.Info[])
  })
  const activeTodos = createMemo(() => todos().filter((todo) => Task.isBlockingStatus(todo.status)))
  const missingSpec = createMemo(() => {
    const focus = focusedTodo()
    return focus ? Task.missingSpec(focus) : []
  })
  const summarizeField = (value?: string, limit = 120) => {
    if (!value) return ""
    const trimmed = value.trim()
    if (!trimmed) return ""
    const [firstLine] = trimmed.split("\n")
    const suffix = trimmed.includes("\n") ? "…" : ""
    return Locale.truncate(`${firstLine}${suffix}`, limit)
  }
  const blockingTodos = createMemo(() => todos().filter((todo) => Task.isBlockingStatus(todo.status)).length)
  const wsg = createMemo(() => webSearchGateStatus(workflow()?.kickoff))
  const wsgMissing = createMemo(() => {
    const status = wsg()
    return status.required && (status.missingReferences || status.missingVersions)
  })
  const wsgLabel = createMemo(() => {
    const status = wsg()
    const missing: string[] = []
    if (status.missingReferences) missing.push("refs")
    if (status.missingVersions) missing.push("versions")
    return missing.length > 0 ? `WSG: ${missing.join(" + ")}` : "WSG: required"
  })

  const cost = createMemo(() => {
    const total = pipe(
      messages(),
      sumBy((x) => (x.role === "assistant" ? x.cost : 0)),
    )
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
    }).format(total)
  })

  const context = createMemo(() => {
    const last = messages().findLast((x) => x.role === "assistant" && x.tokens.output > 0) as AssistantMessage
    const usageTokens = (session() as any)?.usage?.tokens
    const tokens = usageTokens ?? last?.tokens
    if (!tokens) return
    const total = tokens.input + tokens.output + tokens.reasoning + tokens.cache.read + tokens.cache.write
    const model = last
      ? sync.data.provider.find((x) => x.id === last.providerID)?.models[last.modelID]
      : undefined
    let result = total.toLocaleString()
    if (model?.limit.context) {
      result += "  " + Math.round((total / model.limit.context) * 100) + "%"
    }
    return result
  })

  const { theme } = useTheme()
  const keybind = useKeybind()
  const command = useCommandDialog()
  const [hover, setHover] = createSignal<"parent" | "prev" | "next" | null>(null)
  const FieldLine = (props: { label: string; value?: string; warn?: boolean }) => {
    const value = props.value?.trim()
    const display = value && value.length > 0 ? value : "(missing)"
    const valueColor = props.warn ? theme.warning : value ? theme.text : theme.textMuted
    return (
      <text wrapMode="word" fg={props.warn ? theme.warning : theme.textMuted}>
        <span style={{ fg: theme.textMuted }}>{props.label}:</span>{" "}
        <span style={{ fg: valueColor }}>{display}</span>
      </text>
    )
  }
  const WorkflowBadges = () => (
    <Show
      when={
        mode() ||
        track() ||
        kickoffRequired() ||
        nudgeSuggested() ||
        planRequired() ||
        verifyRequired() ||
        wsgMissing() ||
        blockingTodos() > 0
      }
    >
      <box flexDirection="row" gap={1} flexShrink={0}>
        <Show when={mode()}>
          <box backgroundColor={theme.backgroundElement} paddingLeft={1} paddingRight={1}>
            <text fg={theme.textMuted}>Mode: {mode()}</text>
          </box>
        </Show>
        <Show when={track()}>
          <box backgroundColor={theme.backgroundElement} paddingLeft={1} paddingRight={1}>
            <text fg={theme.textMuted}>Track: {track()}</text>
          </box>
        </Show>
        <Show when={kickoffRequired()}>
          <box backgroundColor={theme.backgroundElement} paddingLeft={1} paddingRight={1}>
            <text fg={theme.warning}>Kickoff required</text>
          </box>
        </Show>
        <Show when={nudgeSuggested()}>
          <box backgroundColor={theme.backgroundElement} paddingLeft={1} paddingRight={1}>
            <text fg={theme.warning}>Large task detected</text>
          </box>
        </Show>
        <Show when={planRequired()}>
          <box backgroundColor={theme.backgroundElement} paddingLeft={1} paddingRight={1}>
            <text fg={theme.warning}>Plan required</text>
          </box>
        </Show>
        <Show when={verifyRequired()}>
          <box backgroundColor={theme.backgroundElement} paddingLeft={1} paddingRight={1}>
            <text fg={theme.warning}>Verify required</text>
          </box>
        </Show>
        <Show when={wsgMissing()}>
          <box backgroundColor={theme.backgroundElement} paddingLeft={1} paddingRight={1}>
            <text fg={theme.warning}>{wsgLabel()}</text>
          </box>
        </Show>
        <Show when={blockingTodos() > 0}>
          <box backgroundColor={theme.backgroundElement} paddingLeft={1} paddingRight={1}>
            <text fg={theme.warning}>Todos: {blockingTodos()} blocking</text>
          </box>
        </Show>
      </box>
    </Show>
  )

  return (
    <box flexShrink={0}>
      <box
        paddingTop={1}
        paddingBottom={1}
        paddingLeft={2}
        paddingRight={1}
        {...SplitBorder}
        border={["left"]}
        borderColor={theme.border}
        flexShrink={0}
        backgroundColor={theme.backgroundPanel}
      >
        <Switch>
          <Match when={session()?.parentID}>
            <box flexDirection="row" gap={2}>
              <text fg={theme.text}>
                <b>Subagent session</b>
              </text>
              <box
                onMouseOver={() => setHover("parent")}
                onMouseOut={() => setHover(null)}
                onMouseUp={() => command.trigger("session.parent")}
                backgroundColor={hover() === "parent" ? theme.backgroundElement : theme.backgroundPanel}
              >
                <text fg={theme.text}>
                  Parent <span style={{ fg: theme.textMuted }}>{keybind.print("session_parent")}</span>
                </text>
              </box>
              <box
                onMouseOver={() => setHover("prev")}
                onMouseOut={() => setHover(null)}
                onMouseUp={() => command.trigger("session.child.previous")}
                backgroundColor={hover() === "prev" ? theme.backgroundElement : theme.backgroundPanel}
              >
                <text fg={theme.text}>
                  Prev <span style={{ fg: theme.textMuted }}>{keybind.print("session_child_cycle_reverse")}</span>
                </text>
              </box>
              <box
                onMouseOver={() => setHover("next")}
                onMouseOut={() => setHover(null)}
                onMouseUp={() => command.trigger("session.child.next")}
                backgroundColor={hover() === "next" ? theme.backgroundElement : theme.backgroundPanel}
              >
                <text fg={theme.text}>
                  Next <span style={{ fg: theme.textMuted }}>{keybind.print("session_child_cycle")}</span>
                </text>
              </box>
              <WorkflowBadges />
              <box flexGrow={1} flexShrink={1} />
              <ContextInfo context={context} cost={cost} />
            </box>
          </Match>
          <Match when={true}>
            <box flexDirection="row" justifyContent="space-between" gap={1}>
              <box flexDirection="row" gap={2} alignItems="center">
                <Title session={session} />
                <WorkflowBadges />
              </box>
              <ContextInfo context={context} cost={cost} />
            </box>
          </Match>
        </Switch>
      </box>
      <Show when={focusedTodo()}>
        <box
          paddingLeft={2}
          paddingRight={1}
          paddingBottom={1}
          {...SplitBorder}
          border={["left"]}
          borderColor={theme.border}
          backgroundColor={theme.backgroundPanel}
        >
          <box
            flexDirection="column"
            gap={1}
            paddingLeft={1}
            paddingRight={1}
            paddingTop={1}
            paddingBottom={1}
            backgroundColor={theme.backgroundElement}
          >
            <box flexDirection="row" justifyContent="space-between">
              <text fg={theme.text}>
                <b>
                  Focused task{activeTodos().length > 1 ? ` (${activeTodos().length} active)` : ""}
                </b>
              </text>
              <Show
                when={missingSpec().length > 0}
                fallback={<text fg={theme.textMuted}>Spec ok</text>}
              >
                <box
                  onMouseUp={() => command.trigger("todo.spec.edit")}
                  backgroundColor={theme.backgroundPanel}
                  paddingLeft={1}
                  paddingRight={1}
                >
                  <text fg={theme.warning}>
                    Fill spec <span style={{ fg: theme.textMuted }}>{keybind.print("todo_spec_edit")}</span>
                  </text>
                </box>
              </Show>
            </box>
            <text fg={theme.text} wrapMode="word">
              <b>{focusedTodo()!.content}</b>
            </text>
            <FieldLine label="Action" value={summarizeField(focusedTodo()!.action)} />
            <FieldLine
              label="Verify"
              value={summarizeField(focusedTodo()!.verify)}
              warn={!focusedTodo()!.verify}
            />
            <FieldLine label="Done" value={summarizeField(focusedTodo()!.done)} warn={!focusedTodo()!.done} />
            <Show when={missingSpec().length > 0}>
              <text fg={theme.warning}>Missing spec: {missingSpec().join(" + ")}</text>
            </Show>
          </box>
        </box>
      </Show>
    </box>
  )
}
