import { CYCLE_COMMANDS } from "./commands.js"

export function renderCycleHelp(host?: unknown): string {
  const rows = CYCLE_COMMANDS.map(
    ({ automatic, description, syntax }) => `| \`${syntax}\` | ${description} | ${automatic} |`,
  )
  const hostNotice = hostMessage(host)
  return [
    "# Command Reference",
    "",
    "Select the native `Cycle` agent. Discussion and planning remain read-only; explicit implementation intent starts the governed workflow.",
    "These commands provide deterministic routing, inspection, control, recovery, and expert configuration.",
    "",
    "| Command | Purpose | Automatic equivalent |",
    "| --- | --- | --- |",
    ...rows,
    "",
    "Cancellation, memory removal and export require `--confirm` after explicit user approval.",
    ...(hostNotice === undefined ? [] : ["", hostNotice]),
    "",
  ].join("\n")
}

function hostMessage(host: unknown): string | undefined {
  if (typeof host !== "object" || host === null) return undefined
  const message = (host as { message?: unknown }).message
  return typeof message === "string" && message.length > 0 ? message : undefined
}
