import { spawn } from "node:child_process"
import { join } from "node:path"

export interface WindowsVerificationProcessInstance {
  readonly parentPid: number
  readonly pid: number
  readonly startedAtUnixMillis: number
}

export interface WindowsVerificationInaccessibleProcess {
  readonly parentPid: number
  readonly pid: number
}

export interface WindowsVerificationProcessSnapshot {
  readonly inaccessible: readonly WindowsVerificationInaccessibleProcess[]
  readonly instances: readonly WindowsVerificationProcessInstance[]
  readonly observedAtUnixMillis: number
}

export type WindowsVerificationTermination =
  | { readonly exitCode: number; readonly status: "delivered" }
  | { readonly status: "absent" }
  | { readonly startedAtUnixMillis: number; readonly status: "reused" }

export interface WindowsVerificationTreeAdapter {
  captureRoot(input: {
    readonly rootPid: number
    readonly spawnedAtUnixMillis: number
  }): Promise<WindowsVerificationProcessInstance>
  snapshot(): Promise<WindowsVerificationProcessSnapshot>
  terminate(instance: WindowsVerificationProcessInstance): Promise<WindowsVerificationTermination>
}

const WINDOWS_PROCESS_TREE_HELPER = `Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;

public static class CycleTaskVerificationProcessTree {
  const uint TH32CS_SNAPPROCESS = 0x00000002;
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Auto)]
  struct PROCESSENTRY32 {
    public uint dwSize;
    public uint cntUsage;
    public uint th32ProcessID;
    public IntPtr th32DefaultHeapID;
    public uint th32ModuleID;
    public uint cntThreads;
    public uint th32ParentProcessID;
    public int pcPriClassBase;
    public uint dwFlags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string szExeFile;
  }
  public sealed class Entry {
    public int pid { get; set; }
    public int parentPid { get; set; }
    public long startedAtUnixMillis { get; set; }
  }
  public sealed class InaccessibleEntry {
    public int pid { get; set; }
    public int parentPid { get; set; }
  }
  public sealed class Snapshot {
    public Entry[] instances { get; set; }
    public InaccessibleEntry[] inaccessible { get; set; }
  }
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Auto)]
  static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint processId);
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Auto)]
  static extern bool Process32First(IntPtr snapshot, ref PROCESSENTRY32 entry);
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Auto)]
  static extern bool Process32Next(IntPtr snapshot, ref PROCESSENTRY32 entry);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool CloseHandle(IntPtr handle);
  public static Snapshot List() {
    var instances = new List<Entry>();
    var inaccessible = new List<InaccessibleEntry>();
    var snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    if (snapshot == new IntPtr(-1)) throw new System.ComponentModel.Win32Exception();
    try {
      var item = new PROCESSENTRY32();
      item.dwSize = (uint)Marshal.SizeOf(typeof(PROCESSENTRY32));
      if (!Process32First(snapshot, ref item)) throw new System.ComponentModel.Win32Exception();
      do {
        try {
          var process = Process.GetProcessById((int)item.th32ProcessID);
          instances.Add(new Entry {
            pid = (int)item.th32ProcessID,
            parentPid = (int)item.th32ParentProcessID,
            startedAtUnixMillis = new DateTimeOffset(process.StartTime.ToUniversalTime()).ToUnixTimeMilliseconds()
          });
        } catch (ArgumentException) {
        } catch (InvalidOperationException) {
        } catch (System.ComponentModel.Win32Exception) {
          inaccessible.Add(new InaccessibleEntry {
            pid = (int)item.th32ProcessID,
            parentPid = (int)item.th32ParentProcessID
          });
        }
      } while (Process32Next(snapshot, ref item));
    } finally {
      CloseHandle(snapshot);
    }
    return new Snapshot {
      instances = instances.ToArray(),
      inaccessible = inaccessible.ToArray()
    };
  }
}
'@
`

export function realWindowsVerificationTreeAdapter(): WindowsVerificationTreeAdapter {
  return {
    captureRoot: captureWindowsVerificationRoot,
    snapshot: inspectWindowsVerificationProcesses,
    terminate: terminateWindowsVerificationInstance,
  }
}

async function captureWindowsVerificationRoot(input: {
  readonly rootPid: number
  readonly spawnedAtUnixMillis: number
}): Promise<WindowsVerificationProcessInstance> {
  const snapshot = await inspectWindowsVerificationProcesses()
  if (snapshot.inaccessible.some((entry) => entry.pid === input.rootPid)) {
    throw new Error("Windows verification root process identity access failed")
  }
  const root = snapshot.instances.find((entry) => entry.pid === input.rootPid)
  if (
    root === undefined ||
    root.startedAtUnixMillis < input.spawnedAtUnixMillis - 2_000 ||
    root.startedAtUnixMillis > snapshot.observedAtUnixMillis + 1_000
  ) throw new Error("Windows verification root process identity could not be captured")
  return root
}

async function inspectWindowsVerificationProcesses(): Promise<WindowsVerificationProcessSnapshot> {
  const script = WINDOWS_PROCESS_TREE_HELPER +
    "$ErrorActionPreference='Stop';[CycleTaskVerificationProcessTree]::List()|ConvertTo-Json -Compress -Depth 4"
  const value = await runWindowsVerificationPowerShell(script, {})
  if (
    !isRecord(value) ||
    !Array.isArray(value.instances) ||
    !Array.isArray(value.inaccessible)
  ) throw new Error("Windows verification process inspection returned malformed output")
  return {
    inaccessible: value.inaccessible.map(parseInaccessibleProcess),
    instances: value.instances.map(parseProcessInstance),
    observedAtUnixMillis: Date.now(),
  }
}

async function terminateWindowsVerificationInstance(
  instance: WindowsVerificationProcessInstance,
): Promise<WindowsVerificationTermination> {
  const script = WINDOWS_PROCESS_TREE_HELPER +
    "$ErrorActionPreference='Stop';$request=[Console]::In.ReadToEnd()|ConvertFrom-Json;" +
    "$state=[CycleTaskVerificationProcessTree]::List();" +
    "$blocked=@($state.inaccessible)|Where-Object{$_.pid -eq [int]$request.pid}|Select-Object -First 1;" +
    "if($null -ne $blocked){throw 'process identity access failed'};" +
    "$current=@($state.instances)|Where-Object{$_.pid -eq [int]$request.pid}|Select-Object -First 1;" +
    "if($null -eq $current){@{status='absent'}|ConvertTo-Json -Compress;exit 0};" +
    "if($current.startedAtUnixMillis -ne [int64]$request.startedAtUnixMillis){" +
    "@{startedAtUnixMillis=[int64]$current.startedAtUnixMillis;status='reused'}|ConvertTo-Json -Compress;exit 0};" +
    "$null=& (Join-Path $env:SystemRoot 'System32\\taskkill.exe') /PID ([string]$request.pid) /F 2>$null;" +
    "$code=$LASTEXITCODE;@{exitCode=[int]$code;status='delivered'}|ConvertTo-Json -Compress"
  const value = await runWindowsVerificationPowerShell(script, instance)
  if (!isRecord(value) || typeof value.status !== "string") {
    throw new Error("Windows verification taskkill returned malformed status")
  }
  if (value.status === "absent" && Object.keys(value).sort().join(",") === "status") {
    return { status: "absent" }
  }
  if (
    value.status === "reused" &&
    Object.keys(value).sort().join(",") === "startedAtUnixMillis,status" &&
    Number.isSafeInteger(value.startedAtUnixMillis) &&
    (value.startedAtUnixMillis as number) > 0
  ) {
    return {
      startedAtUnixMillis: value.startedAtUnixMillis as number,
      status: "reused",
    }
  }
  if (
    value.status === "delivered" &&
    Object.keys(value).sort().join(",") === "exitCode,status" &&
    Number.isSafeInteger(value.exitCode)
  ) {
    return { exitCode: value.exitCode as number, status: "delivered" }
  }
  throw new Error("Windows verification taskkill returned malformed status")
}

function parseProcessInstance(value: unknown): WindowsVerificationProcessInstance {
  if (
    !isRecord(value) ||
    !Number.isSafeInteger(value.pid) ||
    !Number.isSafeInteger(value.parentPid) ||
    !Number.isSafeInteger(value.startedAtUnixMillis) ||
    (value.pid as number) <= 0 ||
    (value.startedAtUnixMillis as number) <= 0
  ) throw new Error("Windows verification process inspection returned malformed identity")
  return {
    parentPid: value.parentPid as number,
    pid: value.pid as number,
    startedAtUnixMillis: value.startedAtUnixMillis as number,
  }
}

function parseInaccessibleProcess(value: unknown): WindowsVerificationInaccessibleProcess {
  if (
    !isRecord(value) ||
    !Number.isSafeInteger(value.pid) ||
    !Number.isSafeInteger(value.parentPid) ||
    (value.pid as number) < 0
  ) throw new Error("Windows verification process inspection returned malformed access status")
  return { parentPid: value.parentPid as number, pid: value.pid as number }
}

async function runWindowsVerificationPowerShell(
  script: string,
  request: unknown,
): Promise<unknown> {
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT
  if (systemRoot === undefined) throw new Error("Windows verification requires SystemRoot")
  const executable = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
  const child = spawn(executable, ["-NoProfile", "-NonInteractive", "-Command", script], {
    env: {
      PSModulePath: join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "Modules"),
      SystemRoot: systemRoot,
    },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  })
  if (child.stdin === null || child.stdout === null || child.stderr === null) {
    throw new Error("Windows verification process helper failed to start")
  }
  child.stdin.end(JSON.stringify(request))
  const exited = new Promise<number>((resolve, reject) => {
    child.once("error", reject)
    child.once("exit", (code) => resolve(code ?? 1))
  })
  let timedOut = false
  let timeout: ReturnType<typeof setTimeout> | undefined
  const exit = Promise.race([
    exited,
    new Promise<number>((resolve, reject) => {
      timeout = setTimeout(() => {
        timedOut = true
        child.kill()
        void exited.then(resolve, reject)
      }, 10_000)
    }),
  ])
  let exitCode: number
  let stdout: Buffer
  let stderr: Buffer
  try {
    ;[exitCode, stdout, stderr] = await Promise.all([
      exit,
      readBounded(child.stdout, () => child.kill()),
      readBounded(child.stderr, () => child.kill()),
    ])
  } finally {
    clearTimeout(timeout)
  }

  if (timedOut || exitCode !== 0 || stderr.length !== 0) {
    throw new Error("Windows verification process helper failed")
  }
  try {
    return JSON.parse(stdout.toString("utf8")) as unknown
  } catch {
    throw new Error("Windows verification process helper returned malformed JSON")
  }
}

async function readBounded(
  stream: NodeJS.ReadableStream,
  onLimit: () => void,
): Promise<Buffer> {
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const input of stream) {
    const chunk = typeof input === "string" ? Buffer.from(input) : Buffer.from(input)
    if (bytes + chunk.byteLength > 64 * 1024) {
      onLimit()
      throw new Error("Windows verification process helper output exceeded its limit")
    }
    chunks.push(chunk)
    bytes += chunk.byteLength
  }
  return Buffer.concat(chunks)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
