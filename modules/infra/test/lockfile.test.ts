import { expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import { onlyLockfile, resolveLockfile } from "../../../tools/lib/lockfile.ts"

test("only a lone bun.lock conflict is auto-resolvable", () => {
  expect(onlyLockfile(["bun.lock"])).toBe(true)
  expect(onlyLockfile([])).toBe(false)
  expect(onlyLockfile(["bun.lock", "modules/a/package.json"])).toBe(false)
})

const sh = (cwd: string, cmd: string, ...args: string[]) => {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8" })
  return { code: r.status, out: r.stdout + r.stderr }
}
const pkgA = (deps: string, dev: string) =>
  `{\n  "name": "@x/a",\n  "version": "0.0.0",\n  "dependencies": {${deps}\n  },\n  "scripts": {\n    "x": "1",\n    "y": "2",\n    "z": "3"\n  },\n  "devDependencies": {${dev}\n  }\n}\n`

/** Two branches add different workspace deps to the same package: package.json merges, bun.lock conflicts. */
const conflictedRepo = (): string => {
  const root = mkdtempSync(join(tmpdir(), "dq-lock-"))
  sh(root, "git", "init", "-q", "-b", "main")
  sh(root, "git", "config", "user.email", "t@example.com")
  sh(root, "git", "config", "user.name", "t")
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "root", private: true, workspaces: ["modules/*"] }))
  for (const m of ["a", "b", "c"]) {
    mkdirSync(join(root, "modules", m), { recursive: true })
    writeFileSync(join(root, "modules", m, "package.json"), m === "a" ? pkgA("", "") : JSON.stringify({ name: `@x/${m}`, version: "0.0.0" }))
  }
  sh(root, "bun", "install")
  sh(root, "git", "add", "-A")
  sh(root, "git", "commit", "-qm", "base")
  const edit = (deps: string, dev: string) => {
    writeFileSync(join(root, "modules/a/package.json"), pkgA(deps, dev))
    sh(root, "bun", "install")
    sh(root, "git", "commit", "-qam", "edit")
  }
  sh(root, "git", "checkout", "-qb", "other")
  edit("", '\n    "@x/c": "workspace:*"')
  sh(root, "git", "checkout", "-q", "main")
  sh(root, "git", "checkout", "-qb", "pr")
  edit('\n    "@x/b": "workspace:*"', "")
  return root
}

test("resolveLockfile settles a lockfile-only merge conflict and keeps both sides' deps", () => {
  const root = conflictedRepo()
  expect(sh(root, "git", "merge", "other", "--no-edit").code).not.toBe(0)
  expect(resolveLockfile(root)).toEqual({ status: "resolved" })
  const lock = readFileSync(join(root, "bun.lock"), "utf8")
  expect(lock).not.toContain("<<<<<<<")
  expect(lock).toContain('"@x/b": "workspace:*"')
  expect(lock).toContain('"@x/c": "workspace:*"')
  expect(sh(root, "git", "commit", "--no-edit").code).toBe(0)
  expect(sh(root, "bun", "install", "--frozen-lockfile").code).toBe(0)
})

test("resolveLockfile refuses when another file conflicts too", () => {
  const root = conflictedRepo()
  writeFileSync(join(root, "modules/b/package.json"), '{"name":"@x/b","version":"1.0.0"}')
  sh(root, "git", "commit", "-qam", "b on pr")
  sh(root, "git", "checkout", "-q", "other")
  writeFileSync(join(root, "modules/b/package.json"), '{"name":"@x/b","version":"2.0.0"}')
  sh(root, "git", "commit", "-qam", "b on other")
  sh(root, "git", "checkout", "-q", "pr")
  sh(root, "git", "merge", "other", "--no-edit")
  const res = resolveLockfile(root)
  expect(res.status).toBe("blocked")
})

test("resolveLockfile is a no-op without conflicts", () => {
  const root = conflictedRepo()
  expect(resolveLockfile(root)).toEqual({ status: "clean" })
})
