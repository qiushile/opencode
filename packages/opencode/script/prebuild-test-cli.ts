#!/usr/bin/env bun
// Build a pre-compiled `opencode` binary for subprocess tests, then expose
// it at `dist/test-cli/bin/opencode` for the harness to consume.
//
// Why: each `bun run --conditions=browser src/index.ts <cmd>` spawn pays
// ~15s of JIT + plugin init + DB migration in isolation mode. The
// pre-compiled binary cuts that to ~5s — a 3x improvement on subprocess
// tests that touch the DB (mcp, providers list, etc.).
//
// Usage:
//   bun script/prebuild-test-cli.ts
//   export OPENCODE_TEST_CLI_PATH="$PWD/dist/test-cli/bin/opencode"
//   bun test test/cli/
//
// The harness (see test/lib/cli-process.ts) reads OPENCODE_TEST_CLI_PATH; if
// set, it spawns the binary directly instead of `bun run src/index.ts`. If
// unset, it falls back to dev mode — so this script is strictly opt-in.
//
// Build cost amortizes after ~1 spawn that touches the DB. Recommended for
// CI, manual `bun test test/cli/` runs, and any local iteration where the
// CLI surface itself isn't under change. Skip for normal src/* editing — the
// dev path picks up source changes without rebuild.
import { $ } from "bun"
import fs from "node:fs/promises"
import path from "node:path"

const dir = path.resolve(import.meta.dirname, "..")
process.chdir(dir)

const platform = process.platform === "win32" ? "win32" : process.platform === "darwin" ? "darwin" : "linux"
const arch = process.arch === "x64" ? "x64" : process.arch === "arm64" ? "arm64" : "x64"
const targetDir = path.join(dir, "dist", `opencode-${platform}-${arch}`)
const binaryName = process.platform === "win32" ? "opencode.exe" : "opencode"
const builtBinary = path.join(targetDir, "bin", binaryName)
const stableBinary = path.join(dir, "dist", "test-cli", "bin", binaryName)

const force = process.argv.includes("--force")

// Walk src/ and return the newest mtime seen. Faster than `git status` for
// the freshness check and works for uncommitted edits. Returns 0 on error
// so a missing src/ tree forces a rebuild via the comparison below.
async function newestMtimeMs(root: string): Promise<number> {
  let max = 0
  async function walk(p: string) {
    let entries: { name: string; isDirectory: () => boolean; isFile: () => boolean }[]
    try {
      entries = await fs.readdir(p, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(p, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === "dist") continue
        await walk(full)
      } else if (entry.isFile()) {
        const stat = await fs.stat(full).catch(() => null)
        if (stat && stat.mtimeMs > max) max = stat.mtimeMs
      }
    }
  }
  await walk(root)
  return max
}

async function fresh(): Promise<boolean> {
  const binStat = await fs.stat(builtBinary).catch(() => null)
  if (!binStat) return false
  const srcMs = await newestMtimeMs(path.join(dir, "src"))
  return binStat.mtimeMs > srcMs
}

if (!force && (await fresh())) {
  console.log(`Test CLI binary is up to date: ${builtBinary}`)
} else {
  console.log(`Building test CLI binary for ${platform}-${arch}...`)
  const start = Date.now()
  await $`bun script/build.ts --single --skip-embed-web-ui --skip-install`
  console.log(`Build complete in ${Date.now() - start}ms: ${builtBinary}`)
}

// Verify the binary exists and is executable before symlinking — catches
// a silently-failed build that left a stale or partial output behind.
await fs.access(builtBinary, fs.constants.X_OK).catch(() => {
  throw new Error(`Built binary missing or not executable: ${builtBinary}`)
})

await fs.mkdir(path.dirname(stableBinary), { recursive: true })
await fs.rm(stableBinary, { force: true })
await fs.symlink(builtBinary, stableBinary)
console.log(`Symlinked stable path: ${stableBinary}`)
console.log(``)
console.log(`To use in tests:`)
console.log(`  export OPENCODE_TEST_CLI_PATH="${stableBinary}"`)
console.log(`  bun test test/cli/`)
