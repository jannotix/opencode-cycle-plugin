export type LifecycleState = "working" | "paused" | "blocked" | "failed" | "completed"

export interface LifecycleMessage {
  readonly action: string
  readonly screenReaderText: string
  readonly state: LifecycleState
  readonly summary: string
}

const templates: Readonly<Record<LifecycleState, Omit<LifecycleMessage, "state">>> = {
  working: {
    action: "No action is required unless OpenCode requests approval.",
    screenReaderText: "No action is required. Cycle is working.",
    summary: "Working: Cycle is executing the next eligible task.",
  },
  paused: {
    action: "Run /cycle resume when the project is ready to continue.",
    screenReaderText: "Run /cycle resume. Cycle is paused and state is preserved.",
    summary: "Paused: Cycle will not start new work and current state is preserved.",
  },
  blocked: {
    action: "Inspect /cycle status, then amend the request or run /cycle retry.",
    screenReaderText: "Inspect /cycle status, then amend the request or run /cycle retry.",
    summary: "Blocked: Cycle cannot pass a required gate with the current inputs or limits.",
  },
  failed: {
    action: "Run /cycle doctor and inspect /cycle evidence before retrying.",
    screenReaderText: "Run /cycle doctor, then inspect /cycle evidence before retrying.",
    summary: "Failed: Cycle execution stopped after a classified unrecoverable error.",
  },
  completed: {
    action: "Inspect /cycle evidence or /cycle history for the recorded result.",
    screenReaderText: "Inspect /cycle evidence or /cycle history for the recorded result.",
    summary: "Completed: the Cycle verified candidate passed independent arbitration.",
  },
}

export function lifecycleMessage(state: LifecycleState): LifecycleMessage {
  return { state, ...templates[state] }
}
