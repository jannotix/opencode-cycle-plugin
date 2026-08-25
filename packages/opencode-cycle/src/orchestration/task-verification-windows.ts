import { spawn } from "node:child_process"
import { join } from "node:path"

export interface WindowsVerificationProcessInstance {
  readonly parentPid: number
  readonly pid: number
  readonly startedAtUnixMillis: number
}

export interface WindowsVerificationTreeAdapter {
  snapshot(input: {
    readonly rootPid: number
    readonly rootStartedAtUnixMillis?: number
    readonly spawnedAtUnixMillis: number
  }): Promise<readonly WindowsVerificationProcessInstance[]>
  terminate(root: WindowsVerificationProcessInstance): Promise<number>
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
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Auto)]
  static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint processId);
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Auto)]
  static extern bool Process32First(IntPtr snapshot, ref PROCESSENTRY32 entry);
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Auto)]
  static extern bool Process32Next(IntPtr snapshot, ref PROCESSENTRY32 entry);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool CloseHandle(IntPtr handle);
  public static Entry[] List() {
    var output = new List<Entry>();
    var snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    if (snapshot == new IntPtr(-1)) throw new System.ComponentModel.Win32Exception();
    try {
      var item = new PROCESSENTRY32();
      item.dwSize = (uint)Marshal.SizeOf(typeof(PROCESSENTRY32));
      if (!Process32First(snapshot, ref item)) throw new System.ComponentModel.Win32Exception();
      do {
        try {
          var process = Process.GetProcessById((int)item.th32ProcessID);
          output.Add(new Entry {
            pid = (int)item.th32ProcessID,
            parentPid = (int)item.th32ParentProcessID,
            startedAtUnixMillis = new DateTimeOffset(process.StartTime.ToUniversalTime()).ToUnixTimeMilliseconds()
          });
        } catch (ArgumentException) {
        } catch (InvalidOperationException) {
        } catch (System.ComponentModel.Win32Exception) {
        }
      } while (Process32Next(snapshot, ref item));
    } finally {
      CloseHandle(snapshot);
    }
    return output.ToArray();
  }
}
'@
`

export function realWindowsVerificationTreeAdapter(): WindowsVerificationTreeAdapter {
  return {
    snapshot: inspectWindowsVerificationTree,
    terminate: terminateWindowsVerificationRoot,
  }
}

async function inspectWindowsVerificationTree(input: {
  readonly rootPid: number
  readonly rootStartedAtUnixMillis?: number
  readonly spawnedAtUnixMillis: number
}): Promise<readonly WindowsVerificationProcessInstance[]> {
  const script = `${WINDOWS_PROCESS_TREE_HELPER}$ErrorActionPreference='Stop';$request=[Console]::In.ReadToEnd()|ConvertFrom-Json;$lower=[int64]$request.spawnedAtUnixMillis-2000;$all=@([CycleTaskVerificationProcessTree]::List());$result=@();$queue=[Collections.Generic.Queue[int]]::new();$queue.Enqueue([int]$request.rootPid);$seen=@{};while($queue.Count -gt 0){$parent=$queue.Dequeue();if($seen.ContainsKey($parent)){continue};$seen[$parent]=$true;if($parent -eq [int]$request.rootPid){$root=$all|Where-Object{$_.pid -eq $parent -and $_.startedAtUnixMillis -ge $lower}|Select-Object -First 1;if($null -ne $root -and ($null -eq $request.rootStartedAtUnixMillis -or $root.startedAtUnixMillis -eq [int64]$request.rootStartedAtUnixMillis)){$result+=,$root}};foreach($child in @($all|Where-Object{$_.parentPid -eq $parent -and $_.startedAtUnixMillis -ge $lower})){$result+=,$child;$queue.Enqueue([int]$child.pid)}};@{instances=@($result|Sort-Object startedAtUnixMillis,pid -Unique)}|ConvertTo-Json -Compress -Depth 4`
  const value = await runWindowsVerificationPowerShell(script, input)
  if (!isRecord(value) || !Array.isArray(value.instances)) {
    throw new Error("Windows verification process inspection returned malformed output")
  }
  return value.instances.map((entry) => {
    if (
      !isRecord(entry) ||
      !Number.isSafeInteger(entry.pid) ||
      !Number.isSafeInteger(entry.parentPid) ||
      !Number.isSafeInteger(entry.startedAtUnixMillis) ||
      (entry.pid as number) <= 0 ||
      (entry.startedAtUnixMillis as number) <= 0
    ) throw new Error("Windows verification process inspection returned malformed identity")
    return {
      parentPid: entry.parentPid as number,
      pid: entry.pid as number,
      startedAtUnixMillis: entry.startedAtUnixMillis as number,
    }
  })
}

async function terminateWindowsVerificationRoot(
  root: WindowsVerificationProcessInstance,
): Promise<number> {
  const script = `${WINDOWS_PROCESS_TREE_HELPER}$ErrorActionPreference='Stop';$request=[Console]::In.ReadToEnd()|ConvertFrom-Json;$current=@([CycleTaskVerificationProcessTree]::List())|Where-Object{$_.pid -eq [int]$request.pid}|Select-Object -First 1;if($null -eq $current){@{exitCode=0;status='absent'}|ConvertTo-Json -Compress;exit 0};if($current.startedAtUnixMillis -ne [int64]$request.startedAtUnixMillis){throw 'process identity changed'};$null=& (Join-Path $env:SystemRoot 'System32\\taskkill.exe') /PID ([string]$request.pid) /T /F 2>$null;$code=$LASTEXITCODE;@{exitCode=[int]$code;status='delivered'}|ConvertTo-Json -Compress`
  const value = await runWindowsVerificationPowerShell(script, root)
  if (!isRecord(value) || !Number.isSafeInteger(value.exitCode)) {
    throw new Error("Windows verification taskkill returned malformed status")
  }
  return value.exitCode as number
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
  const exit = Promise.race([
    exited,
    delay(10_000).then(async () => {
      timedOut = true
      child.kill()
      return exited
    }),
  ])
  const [exitCode, stdout, stderr] = await Promise.all([
    exit,
    readBounded(child.stdout, () => child.kill()),
    readBounded(child.stderr, () => child.kill()),
  ])
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
    if (bytes + chunk.byteLength > 32 * 1024) {
      onLimit()
      throw new Error("Windows verification process helper output exceeded its limit")
    }
    chunks.push(chunk)
    bytes += chunk.byteLength
  }
  return Buffer.concat(chunks)
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
