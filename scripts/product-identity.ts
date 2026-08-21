export const PRODUCT_IDENTITY = {
  activationMarker: "Cycle for OpenCode activated",
  agent: "Cycle",
  command: "cycle",
  mainPackage: "opencode-cycle",
  product: "Cycle for OpenCode",
  repository: "https://github.com/jannotix/opencode-cycle-plugin",
  service: "opencode-cycle",
  tools: ["cycle_control", "cycle_role", "cycle_browser"],
} as const

export const NATIVE_PACKAGE_NAMES = [
  "@opencode-cycle/native-linux-x64",
  "@opencode-cycle/native-win32-x64",
] as const

export const SHIPPED_NATIVE_PACKAGE_NAMES = NATIVE_PACKAGE_NAMES
