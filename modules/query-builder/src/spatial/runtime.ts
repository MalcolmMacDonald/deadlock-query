/**
 * Entry of the spatial runtime the sandbox worker loads when a bundle ships baked data. Built (IIFE) by the app build into
 * `library.json` (`spatial`); the worker then turns the bundle's `collision.bvh` / `navmesh.bin` buffers into the
 * `spatial` input of `MapContext.fromBundle` (with spatial-core's semantics, placeholder or final, so queries 2 and 3 run and are flagged provisional). Kept out of the library artifact: the library takes a structural backend.
 */
import { DEFAULT_PARAMS, NavMesh, PLACEHOLDER_SEMANTICS, Raycaster, isInterior, isVisible, nearestWall } from "@deadlock-query/spatial-core"

;(globalThis as { __dlqSpatial?: unknown }).__dlqSpatial = { Raycaster, NavMesh, semantics: { placeholder: PLACEHOLDER_SEMANTICS, isInterior, isVisible, nearestWall }, params: DEFAULT_PARAMS }
