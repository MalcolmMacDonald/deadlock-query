/**
 * Dockview (4.13) puts `aria-level="0"` on the container of a floating group, which axe rejects as an invalid value
 * (critical: aria-valid-attr-value / aria-allowed-attr). The attribute carries no meaning there, so drop it as floating groups appear.
 */
export const stripInvalidAriaLevel = (root: ParentNode): void => {
  root.querySelectorAll('.dv-resize-container[aria-level="0"]').forEach((el) => el.removeAttribute("aria-level"))
}

/** Keeps `root` clean for as long as it lives; returns a stop function. */
export const keepDockviewAriaValid = (root: HTMLElement): (() => void) => {
  stripInvalidAriaLevel(root)
  const observer = new MutationObserver(() => stripInvalidAriaLevel(root))
  observer.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ["aria-level"] })
  return () => observer.disconnect()
}
