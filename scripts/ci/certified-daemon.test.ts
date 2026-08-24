import { expect, test } from "bun:test"
import { access, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  desktopCertificationProcessToken,
  writeDesktopDaemonMarker,
  type DesktopCertificationBinding,
} from "../../packages/opencode-cycle/src/certification.js"
import {
  cleanupCertifiedDaemon,
  type CertifiedProcessAdapter,
} from "./certified-daemon.js"

function binding(root: string): DesktopCertificationBinding {
  return {
    nativePackageSha256: "d".repeat(64),
    nonce: "b".repeat(64),
    pluginPackageSha256: "c".repeat(64),
    revision: "a".repeat(40),
    root,
    startedAtUnixMillis: 1_700_000_000_000,
  }
}

test("certified daemon cleanup refuses a reused PID without terminating it", async () => {
  const root = await mkdtemp(join(tmpdir(), "cycle-cert-daemon-mismatch-"))
  const binary = join(root, "workflowd.exe")
  await writeFile(binary, "fixture")
  const run = binding(root)
  await writeDesktopDaemonMarker(run, {
    binaryPath: await realpath(binary),
    pid: 4242,
    startToken: desktopCertificationProcessToken(run),
    startedAtUnixMillis: run.startedAtUnixMillis + 1,
  })
  let terminated = false
  const adapter: CertifiedProcessAdapter = {
    async inspect(pid) {
      return { binaryPath: join(root, "different.exe"), ownerTokenPresent: true, pid }
    },
    sleep: Bun.sleep,
    async terminate() { terminated = true },
  }
  try {
    await expect(cleanupCertifiedDaemon({
      binding: run,
      environment: {},
      expectedBinaryPath: binary,
      platform: "windows-x64",
      processAdapter: adapter,
    })).rejects.toThrow("non-matching")
    expect(terminated).toBe(false)
  } finally {
    await rm(root, { force: true, recursive: true })
  }
})

for (const platform of ["windows-x64", "linux-x64"] as const) {
  test(`certified ${platform} cleanup terminates and waits for a detached grandchild`, async () => {
    const root = await mkdtemp(join(tmpdir(), `cycle-cert-daemon-${platform}-`))
    const pidFile = join(root, "grandchild.pid")
    const launcher = join(root, "launcher.ts")
    const binary = await realpath(process.execPath)
    const run = binding(root)
    let pid = 0
    try {
      await writeFile(
        launcher,
        `const child = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], { detached: true, stderr: "ignore", stdout: "ignore" }); child.unref(); await Bun.write(${JSON.stringify(pidFile)}, String(child.pid));\n`,
      )
      const parent = Bun.spawn([process.execPath, launcher], { stderr: "ignore", stdout: "ignore" })
      expect(await parent.exited).toBe(0)
      for (let attempt = 0; attempt < 100; attempt += 1) {
        pid = Number.parseInt(await readFile(pidFile, "utf8").catch(() => "0"), 10)
        if (pid > 0) break
        await Bun.sleep(10)
      }
      expect(pid).toBeGreaterThan(0)
      await writeDesktopDaemonMarker(run, {
        binaryPath: binary,
        pid,
        startToken: desktopCertificationProcessToken(run),
        startedAtUnixMillis: run.startedAtUnixMillis + 1,
      })
      const adapter: CertifiedProcessAdapter = {
        async inspect(target) {
          try {
            process.kill(target, 0)
            return { binaryPath: binary, ownerTokenPresent: true, pid: target }
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ESRCH") return undefined
            throw error
          }
        },
        sleep: Bun.sleep,
        async terminate(target, force) {
          try {
            process.kill(target, force ? "SIGKILL" : "SIGTERM")
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error
          }
        },
      }
      await expect(cleanupCertifiedDaemon({
        binding: run,
        environment: {},
        expectedBinaryPath: binary,
        platform,
        processAdapter: adapter,
      })).resolves.toMatchObject({ markerPublished: true, pid, terminated: true })
      expect(() => process.kill(pid, 0)).toThrow()
      await rm(root, { force: true, recursive: true })
      expect(await access(root).then(() => true, () => false)).toBe(false)
    } finally {
      if (pid > 0) {
        try { process.kill(pid, "SIGKILL") } catch {}
      }
      await rm(root, { force: true, recursive: true })
    }
  }, 20_000)
}
