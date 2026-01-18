import { Show } from "solid-js"
import { useTheme } from "../context/theme"

export interface TodoItemProps {
  status: string
  content: string
  dependsOn?: string[]
  blocks?: string[]
  missingSpec?: string[]
  specComplete?: boolean
  blockedByDeps?: boolean
  ready?: boolean
}

export function TodoItem(props: TodoItemProps) {
  const { theme } = useTheme()
  const isCompleted = props.status === "closed"
  const isInProgress = props.status === "in_progress"
  const isBlocked = props.status === "blocked"
  const isDeferred = props.status === "deferred"
  const isDraft = props.status === "draft"
  const indicator = isCompleted ? "✓" : isInProgress ? "•" : isBlocked ? "!" : isDeferred ? "-" : isDraft ? "~" : " "
  const indicatorColor = isBlocked
    ? theme.error
    : isInProgress
      ? theme.warning
      : isCompleted
        ? theme.success
        : theme.textMuted
  const textColor = isBlocked ? theme.error : isInProgress ? theme.warning : theme.textMuted

  const meta: string[] = []
  if (props.dependsOn && props.dependsOn.length > 0) meta.push(`deps:${props.dependsOn.length}`)
  if (props.blocks && props.blocks.length > 0) meta.push(`blocks:${props.blocks.length}`)
  if (props.blockedByDeps) meta.push("blocked by deps")
  if (props.ready) meta.push("ready")
  if (props.missingSpec && props.missingSpec.length > 0) {
    meta.push(`spec:${props.missingSpec.join("+")}`)
  } else if (props.specComplete) {
    meta.push("spec:ok")
  }

  return (
    <box flexDirection="column">
      <box flexDirection="row" gap={0}>
        <text
          flexShrink={0}
          style={{
            fg: indicatorColor,
          }}
        >
          [{indicator}]{" "}
        </text>
        <text
          flexGrow={1}
          wrapMode="word"
          style={{
            fg: textColor,
          }}
        >
          {props.content}
        </text>
      </box>
      <Show when={meta.length > 0}>
        <text fg={theme.textMuted}>{meta.join(" • ")}</text>
      </Show>
    </box>
  )
}
