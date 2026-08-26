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

// Certified means a Desktop certification receipt exists for the platform on
// the released revision. Compatible means the package is built, published and
// resolvable, with no Desktop certification claimed. The two sets are disjoint
// and their union is what ships.
export const CERTIFIED_NATIVE_PACKAGE_NAMES = [
  "@opencode-cycle/native-linux-x64",
  "@opencode-cycle/native-win32-x64",
] as const

export const COMPATIBLE_NATIVE_PACKAGE_NAMES = [
  "@opencode-cycle/native-darwin-arm64",
  "@opencode-cycle/native-darwin-x64",
] as const

export const NATIVE_PACKAGE_NAMES = [
  "@opencode-cycle/native-darwin-arm64",
  "@opencode-cycle/native-darwin-x64",
  "@opencode-cycle/native-linux-x64",
  "@opencode-cycle/native-win32-x64",
] as const

export const SHIPPED_NATIVE_PACKAGE_NAMES = NATIVE_PACKAGE_NAMES
