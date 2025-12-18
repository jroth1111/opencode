import { onMount } from "solid-js"
import { useDialog } from "../ui/dialog"
import { TextAttributes } from "@opentui/core"
import { useTheme } from "../context/theme"

export function Permission() {
  const dialog = useDialog()
  onMount(() => {})
  return null
}

function DialogPermission() {
  const dialog = useDialog()
  const { theme } = useTheme()

  onMount(() => {
    dialog.setSize("medium")
  })

  return (
    <box
      gap={1}
      paddingLeft={2}
      paddingRight={2}
      onKeyDown={(e) => {
        console.log(e)
      }}
      ref={(r) => {
        setTimeout(() => {
          r?.focus()
        }, 1)
      }}
    >
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD}>Permission Request</text>
        <text fg={theme.textMuted}>esc</text>
      </box>
      <text fg={theme.textMuted}>Change to foo directory and create bar file</text>
      <text>$ cd foo && touch bar</text>
      <box paddingBottom={1}>
        <box paddingLeft={2} paddingRight={2} backgroundColor={theme.primary}>
          <text fg={theme.background}>Allow</text>
        </box>
        <box paddingLeft={2} paddingRight={2}>
          <text>Always allow the touch command</text>
        </box>
        <box paddingLeft={2} paddingRight={2}>
          <text>Reject</text>
        </box>
      </box>
    </box>
  )
}
