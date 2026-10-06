export type Target = "prod" | "dev"

/**
 * The deploy target. `VITE_TARGET` (set when building the shell) wins; otherwise `vite dev` is "dev" and any build is "prod",
 * so a build that forgot the flag omits dev-only modules rather than shipping them.
 */
export const resolveTarget = (flag: string | undefined, isDevServer: boolean): Target =>
  flag === "dev" || flag === "prod" ? flag : isDevServer ? "dev" : "prod"

export const target: Target = resolveTarget(import.meta.env?.VITE_TARGET, Boolean(import.meta.env?.DEV))
