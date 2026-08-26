import { expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { parseDocument } from "yaml"

interface WorkflowStep {
  readonly env?: Record<string, string>
  readonly name?: string
  readonly run?: string
  readonly uses?: string
  readonly with?: Record<string, unknown>
}

interface WorkflowJob {
  readonly env?: Record<string, string>
  readonly environment?: unknown
  readonly needs?: string | string[]
  readonly permissions?: Record<string, string>
  readonly steps: WorkflowStep[]
  readonly strategy?: { readonly matrix?: { readonly include?: Record<string, string>[] } }
}

interface Workflow {
  readonly env?: Record<string, string>
  readonly jobs: Record<string, WorkflowJob>
  readonly permissions?: Record<string, string>
}

test("Release Candidate and publish workflows share one parsed artifact layout", async () => {
  const candidate = await workflow("release-candidate.yml")
  const publish = await workflow("publish.yml")
  expect(candidate.jobs.candidate?.needs).toEqual([
    "quality",
    "security",
    "plugin",
    "native",
    "desktop",
    "repeatability",
    "scale",
  ])
  expect(candidate.jobs.desktop?.strategy?.matrix?.include?.map((item) => item.platform).sort()).toEqual([
    "linux-x64",
    "windows-x64",
  ])
  expect(candidate.jobs.quality?.strategy?.matrix?.include?.map((item) => item.platform).sort()).toEqual([
    "Linux x64",
    "Windows x64",
  ])

  const desktopUpload = stepUsing(candidate.jobs.desktop, "actions/upload-artifact")
  expect(desktopUpload.with?.path).toBe("target/certification/desktop/${{ matrix.platform }}.json")
  expect(stepUsing(candidate.jobs.scale, "actions/upload-artifact").with?.path).toBe(
    "target/certification/codebase-500k.json",
  )
  expect(stepUsing(candidate.jobs.repeatability, "actions/upload-artifact").with?.path).toBe(
    "target/certification/critical-suite.json",
  )
  const sealRuns = runs(candidate.jobs.candidate)
  expect(sealRuns.some((run) => run.includes("candidate/opencode-cycle-$CANDIDATE_VERSION.cdx.json"))).toBeTrue()
  expect(sealRuns.some((run) => run.includes("--certifications-directory candidate/certifications"))).toBeTrue()

  const publishRun = runs(publish.jobs.publish).join("\n")
  expect(publishRun).toContain("candidate/certifications/*.json")
  expect(publishRun).toContain('candidate/opencode-cycle-$VERSION.cdx.json')
  expect(publishRun).not.toContain("candidate/certifications/scale/")
})

test("workflow-dispatch version is environment-bound, validated and never interpolated into shell", async () => {
  const candidate = await workflow("release-candidate.yml")
  expect(candidate.env?.CANDIDATE_VERSION).toBe("${{ inputs.version }}")
  const allRuns = Object.values(candidate.jobs).flatMap(runs)
  expect(allRuns.some((run) => run.includes("validate-version.ts"))).toBeTrue()
  expect(allRuns.some((run) => run.includes('"$CANDIDATE_VERSION"'))).toBeTrue()
  expect(allRuns.every((run) => !run.includes("${{ inputs.version }}"))).toBeTrue()
})

test("one canonical Linux plugin package is the immutable input to both Desktop lanes", async () => {
  const candidate = await workflow("release-candidate.yml")
  const pluginUploads = candidate.jobs.plugin?.steps.filter((step) =>
    step.uses?.startsWith("actions/upload-artifact@")
  ) ?? []
  const archiveUpload = pluginUploads.find((step) => step.with?.name === "plugin-package")
  const provenanceUpload = pluginUploads.find((step) =>
    step.with?.name === "plugin-package-provenance"
  )
  expect(archiveUpload?.with?.path).toBe("candidate/plugin/*.tgz")
  expect(provenanceUpload?.with?.path).toBe("candidate/plugin/*.provenance.json")

  const desktopDownloads = candidate.jobs.desktop?.steps.filter((step) =>
    step.uses?.startsWith("actions/download-artifact@")
  ) ?? []
  expect(desktopDownloads.some((step) => step.with?.name === "plugin-package")).toBeTrue()
  expect(desktopDownloads.some((step) =>
    step.with?.name === "plugin-package-provenance"
  )).toBeTrue()

  const desktopRuns = runs(candidate.jobs.desktop)
  const certification = desktopRuns.find((run) => run.includes("desktop-certification.ts"))
  expect(certification).toContain(
    '--plugin-archive "candidate/plugin/opencode-cycle-$CANDIDATE_VERSION.tgz"',
  )
  expect(certification).toContain(
    '--plugin-provenance "candidate/plugin/opencode-cycle-$CANDIDATE_VERSION.tgz.provenance.json"',
  )
  expect(desktopRuns.every((run) => !run.includes("bun pm pack"))).toBeTrue()
})

test("publication authenticates through trusted publishing, never a static npm token", async () => {
  const publish = await workflow("publish.yml")
  const source = await workflowSource("publish.yml")
  const job = publish.jobs.publish

  // OIDC is the authority: without id-token: write no short-lived npm
  // credential can be minted, and npm silently falls back to whatever token
  // is in the environment.
  expect((job?.permissions ?? publish.permissions)?.["id-token"]).toBe("write")

  // Human-approved, protected environment is the only authorized path.
  expect(job?.environment).toBe("release")

  // No static publish credential may reach npm: not as a YAML env
  // assignment, not through any repository secret, and not through an
  // .npmrc credential template written by setup-node's registry-url.
  // Shell assertions that a variable is *empty* are the opposite of a
  // credential path and stay allowed.
  expect(source).not.toMatch(/^\s*(?:NODE_AUTH_TOKEN|NPM_TOKEN)\s*:/mu)
  expect(source).not.toMatch(/secrets\s*\.\s*\w*NPM\w*/iu)
  const setupNode = (job?.steps ?? []).find((step) => step.uses?.includes("actions/setup-node@"))
  expect(Object.keys(setupNode?.with ?? {})).not.toContain("registry-url")
  const publishEnv = (job?.steps ?? []).flatMap((step) => Object.keys(step.env ?? {}))
  expect(publishEnv.every((name) => !/NPM_TOKEN|NODE_AUTH_TOKEN|npm_token/u.test(name))).toBeTrue()

  // The job must fail closed when the OIDC request context is absent,
  // instead of silently attempting an unauthenticated publish.
  const guard = runs(job).find((run) => run.includes("ACTIONS_ID_TOKEN_REQUEST_URL"))
  if (guard === undefined) throw new Error("Publish workflow does not verify its OIDC context")
  expect(guard).toContain("ACTIONS_ID_TOKEN_REQUEST_TOKEN")
  expect(guard).toContain("_authToken")

  // Trusted publishing requires an npm CLI that can exchange the OIDC token.
  const npmInstall = runs(job).find((run) => run.includes("npm install --global npm@"))
  const pinned = /npm install --global npm@(\d+)\.(\d+)\.(\d+)/u.exec(npmInstall ?? "")
  if (pinned === null) throw new Error("Publish workflow does not pin an npm CLI")
  const [major, minor, patch] = pinned.slice(1, 4).map(Number) as [number, number, number]
  expect(major > 11 || (major === 11 && (minor > 5 || (minor === 5 && patch >= 1)))).toBeTrue()

  // Every archive in the publication order publishes with first-publication
  // public access.
  const publishStep = runs(job).find((run) => run.includes("npm publish"))
  expect(publishStep).toContain("candidate/publication-order.txt")
  expect(publishStep).toContain("--access public")
})

test("all workflow actions remain pinned to full commit SHAs", async () => {
  for (const name of ["release-candidate.yml", "publish.yml"]) {
    const value = await workflow(name)
    const actions = Object.values(value.jobs)
      .flatMap((job) => job.steps)
      .flatMap((step) => step.uses === undefined ? [] : [step.uses])
    expect(actions.length).toBeGreaterThan(0)
    expect(actions.every((action) => /@[0-9a-f]{40}$/u.test(action))).toBeTrue()
  }
})

async function workflow(name: string): Promise<Workflow> {
  const document = parseDocument(await workflowSource(name))
  if (document.errors.length > 0) throw document.errors[0]
  return document.toJS({ maxAliasCount: 0 }) as Workflow
}

async function workflowSource(name: string): Promise<string> {
  return readFile(resolve(import.meta.dir, "../../.github/workflows", name), "utf8")
}

function runs(job: WorkflowJob | undefined): string[] {
  return (job?.steps ?? []).flatMap((step) => typeof step.run === "string" ? [step.run] : [])
}

function stepUsing(job: WorkflowJob | undefined, action: string): WorkflowStep {
  const step = (job?.steps ?? []).find((item) => item.uses?.startsWith(`${action}@`))
  if (step === undefined) throw new Error(`Workflow is missing ${action}`)
  return step
}
