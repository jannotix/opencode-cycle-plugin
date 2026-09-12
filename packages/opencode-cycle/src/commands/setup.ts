import type { WorkflowRole } from "../permissions.js"

export interface AvailableModel {
  readonly id: string
  readonly name: string
  readonly providerId: string
  readonly status: "active" | "alpha" | "beta" | "deprecated"
}

export interface ProviderInventory {
  readonly defaults: Readonly<Record<string, string>>
  readonly models: readonly AvailableModel[]
  readonly providers: readonly { readonly id: string; readonly name: string; readonly source: string }[]
}

export interface SetupReport {
  readonly activeModel: string | null
  readonly activeVariant: string | null
  readonly correlationWarning: string | null
  /** Set when the delegation deny cannot be confirmed to reach this host. Null when it can. */
  readonly delegationWarning: string | null
  readonly permissionPreset: "balanced"
  readonly providers: ProviderInventory["providers"]
  readonly roleModels: Readonly<Record<WorkflowRole, string | null>>
  readonly roleVariants: Readonly<Partial<Record<WorkflowRole, string>>>
  readonly stableModels: readonly AvailableModel[]
}

export type ProviderResponse = {
  readonly default: Readonly<Record<string, string>>
  readonly providers: readonly {
    readonly id: string
    readonly models: Readonly<
      Record<string, { readonly id: string; readonly name: string; readonly status: AvailableModel["status"] }>
    >
    readonly name: string
    readonly source: string
  }[]
}

export function inspectProviders(response: ProviderResponse): ProviderInventory {
  return {
    defaults: { ...response.default },
    models: response.providers
      .flatMap((provider) =>
        Object.values(provider.models).map((model) => ({
          id: model.id,
          name: model.name,
          providerId: provider.id,
          status: model.status,
        })),
      )
      .sort((left, right) =>
        `${left.providerId}/${left.id}`.localeCompare(`${right.providerId}/${right.id}`),
      ),
    providers: response.providers
      .map(({ id, name, source }) => ({ id, name, source }))
      .sort((left, right) => left.id.localeCompare(right.id)),
  }
}

export function setupReport(
  inventory: ProviderInventory,
  activeModel: string | null,
  activeVariant: string | null,
  configured: Partial<Readonly<Record<WorkflowRole, string>>>,
  variants: Partial<Readonly<Record<WorkflowRole, string>>>,
  delegationWarning?: string,
): SetupReport {
  const roles: readonly WorkflowRole[] = [
    "architect",
    "executor",
    "functional_reviewer",
    "security_reviewer",
    "arbiter",
  ]
  const roleModels = Object.fromEntries(
    roles.map((role) => [role, configured[role] ?? activeModel]),
  ) as Record<WorkflowRole, string | null>
  const reviewModels = [
    roleModels.functional_reviewer,
    roleModels.security_reviewer,
    roleModels.arbiter,
  ].filter((model): model is string => model !== null)
  const correlationWarning =
    reviewModels.length === 3 && new Set(reviewModels).size === 1
      ? "Both reviewers and the arbiter use the same model. Independence boundaries remain active, but correlated model errors are more likely."
      : null
  return {
    activeModel,
    activeVariant,
    correlationWarning,
    delegationWarning: delegationWarning ?? null,
    permissionPreset: "balanced",
    providers: inventory.providers,
    roleModels,
    roleVariants: { ...variants },
    stableModels: inventory.models.filter((model) => model.status === "active"),
  }
}
