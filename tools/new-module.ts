import { existsSync, mkdirSync, writeFileSync } from "node:fs"

const id = process.argv[2]
if (!id || !/^[a-z][a-z0-9-]*$/.test(id)) { console.error("usage: new-module <kebab-id>"); process.exit(1) }
const dir = `modules/${id}`
if (existsSync(dir)) { console.error(`${dir} exists`); process.exit(1) }
mkdirSync(`${dir}/src`, { recursive: true })
mkdirSync(`${dir}/test`)
const w = (f: string, s: string) => writeFileSync(`${dir}/${f}`, s)
w("module.json", JSON.stringify({ id, version: "0.0.0", kind: "lib", dependsOn: [], devOnly: false, firstPhase: "1", paths: [`modules/${id}/**`] }, null, 2) + "\n")
w("package.json", JSON.stringify({ name: `@deadlock-query/${id}`, version: "0.0.0", type: "module", exports: { ".": "./src/index.ts" }, scripts: { typecheck: "tsc -p .", test: "bun test --pass-with-no-tests", verify: "bun run typecheck && bun run test" }, dependencies: { "@deadlock-query/contracts": "workspace:*" } }, null, 2) + "\n")
w("tsconfig.json", `{ "extends": "../../tsconfig.base.json", "include": ["src", "test"] }\n`)
w("src/index.ts", "export {}\n")
w("PLAN.md", `# ${id} — plan\n\nSee IMPLEMENTATION_PLAN.md §9 for the template.\n`)
w("STATE.md", `# ${id} — state\n\n- **Status:** not started\n- **Version:** 0.0.0\n\n## Done\n## Next\n## Blockers / Requests to other modules\n## Decisions log\n`)
w("CLAUDE.md", `# ${id} — agent entry point\n\nRead PLAN.md then STATE.md. Only modify modules/${id}/ (+ bun.lock). Run \`bun run verify\` and update STATE.md before finishing.\n`)
console.log(`created ${dir}; run bun install`)
