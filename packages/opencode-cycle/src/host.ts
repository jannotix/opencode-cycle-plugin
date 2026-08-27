import type { Config, Plugin, PluginInput, PluginOptions } from "@opencode-ai/plugin"
import type { Part, SessionStatus } from "@opencode-ai/sdk"

/**
 * The single boundary between Cycle and the OpenCode plugin API.
 *
 * The host's plugin API changes shape with its major version, so every
 * reference to it lives here and the rest of the tree imports these names
 * instead. A port to a different host major rewrites this file and the tool
 * runtime, not the orchestration layer; `host-boundary.test.ts` fails if a
 * direct import reappears elsewhere.
 *
 * Cycle needs four things from the host: a client for sessions, agents and
 * provider metadata; the project and worktree directories; the server URL; and
 * the plugin entry contract itself.
 */

/** Host client: sessions, agents, provider inventory and logging. */
export type HostClient = PluginInput["client"]

/** A message part exchanged with a host session. */
export type HostPart = Part

/** Lifecycle status of a host session. */
export type HostSessionStatus = SessionStatus

/** The plugin entry contract the host loads. */
export type HostPlugin = Plugin

/** The host input handed to the plugin entry. */
export type HostPluginInput = PluginInput

/** Options the host passes through from its configuration. */
export type HostPluginOptions = PluginOptions

/** The host configuration a plugin may extend. */
export type HostConfig = Config
