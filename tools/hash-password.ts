import { hashPassword } from "../modules/infra/src/auth.ts"

const pw = process.argv[2] ?? prompt("Dev site password:")
if (!pw) { console.error("usage: bun tools/hash-password.ts [password]"); process.exit(1) }
console.log(await hashPassword(pw))
