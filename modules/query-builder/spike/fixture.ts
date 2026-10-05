/** Fixture stand-in for query-library's `index.d.ts` + runtime (S1 only). */
export const FIXTURE_DTS = `
/** A point in map space (metres). */
declare class Vec3 {
  constructor(x: number, y: number, z: number);
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** Euclidean distance to another point. */
  distanceTo(other: Vec3): number;
}
/** Team colours used by lanes and spawns. */
type TeamColor = "yellow" | "blue" | "purple" | "green";
interface Spawn { readonly id: number; readonly team: TeamColor; readonly position: Vec3 }
interface MapContext {
  /** All spawn points on the map. */
  spawns(): Spawn[];
  /** Spawns of one team. */
  spawnsOf(team: TeamColor): Spawn[];
  /** Walkable distance in seconds between two points (placeholder). */
  travelTime(from: Vec3, to: Vec3): number;
}
declare const map: MapContext;
`

export const FIXTURE_RUNTIME = `
class Vec3 { constructor(x,y,z){this.x=x;this.y=y;this.z=z} distanceTo(o){return Math.hypot(this.x-o.x,this.y-o.y,this.z-o.z)} }
const _spawns = Array.from({length: 8}, (_, i) => ({ id: i, team: ["yellow","blue","purple","green"][i % 4], position: new Vec3(i * 10, 0, i) }));
globalThis.map = {
  spawns: () => _spawns,
  spawnsOf: (t) => _spawns.filter((s) => s.team === t),
  travelTime: (a, b) => a.distanceTo(b) / 7,
};
`
