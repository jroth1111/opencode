import { useTheme } from "../context/theme"

export interface TodoItemProps {
  status: string
  content: string
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

  return (
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
  )
}
