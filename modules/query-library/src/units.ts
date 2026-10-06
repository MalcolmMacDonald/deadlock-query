/**
 * Distances are Source world units (D5). These helpers make intent explicit in a one-liner.
 */

/** Source units per metre (1 unit = 1/16 ft = 0.01905 m).
 * @category Units */
export const UNITS_PER_METER = 1 / 0.01905

/**
 * A distance already expressed in Source units (identity, for readability).
 * @example map.healingOrbs.within(units(1500), map.guardians)
 * @category Units
 */
export const units = (n: number): number => n

/**
 * Convert metres to Source units.
 * @example map.healingOrbs.within(meters(30), map.guardians)
 * @category Units
 */
export const meters = (n: number): number => n * UNITS_PER_METER
