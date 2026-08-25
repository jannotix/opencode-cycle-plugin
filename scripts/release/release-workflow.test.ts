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
  readonly needs?: string | string[]
  readonly steps: WorkflowStep[]
  readonly strategy?: { readonly matrix?: { readonly include?: Record<string, string>[] } }
}

interface Workflow {
  readonly env?: Record<string, string>
  readonly jobs: Record<string, WorkflowJob>
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
  const path = resolve(import.meta.dir, "../../.github/workflows", name)
  const document = parseDocument(await readFile(path, "utf8"))
  if (document.errors.length > 0) throw document.errors[0]
  return document.toJS({ maxAliasCount: 0 }) as Workflow
}

function runs(job: WorkflowJob | undefined): string[] {
  return (job?.steps ?? []).flatMap((step) => typeof step.run === "string" ? [step.run] : [])
}

function stepUsing(job: WorkflowJob | undefined, action: string): WorkflowStep {
  const step = (job?.steps ?? []).find((item) => item.uses?.startsWith(`${action}@`))
  if (step === undefined) throw new Error(`Workflow is missing ${action}`)
  return step
}
