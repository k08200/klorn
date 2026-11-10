/**
 * Compatibility path: the LaneChip moved to the UI primitives (P2). Existing
 * call sites import from here and keep compiling; new code imports
 * `./ui/lane-chip` directly.
 */
export { LaneChip, type LaneChipProps } from "./ui/lane-chip";
