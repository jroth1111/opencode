import { useTheme } from "../context/theme"

export interface TodoItemProps {
  status: string
  content: string
}

export function TodoItem(props: TodoItemProps) {
  const { theme } = useTheme()
  const isCompleted = props.status === "completed"
  const isInProgress = props.status === "in_progress"
  const isBlocked = props.status === "blocked"
  const isDeferred = props.status === "deferred" || props.status === "cancelled"
  const indicator = isCompleted ? "✓" : isInProgress ? "•" : isBlocked ? "!" : isDeferred ? "-" : " "
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
