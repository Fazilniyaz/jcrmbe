import crypto from "node:crypto";

/*
 * Human-facing codes: JDX-041, PRJ-101, TSK-412.
 *
 * The next code is the highest number already in use plus one — max rather than
 * count, so deleting a record never hands the same code out twice. This mirrors
 * lib/store/selectors.ts `nextCode` in the frontend exactly, including the pad
 * widths, so codes generated before the backend existed keep their series.
 */

export function nextCode(existing: readonly string[], prefix: string, pad: number): string {
  let max = 0;
  for (const value of existing) {
    const match = /(\d+)\s*$/.exec(value ?? "");
    if (match?.[1]) max = Math.max(max, Number(match[1]));
  }
  return `${prefix}-${String(max + 1).padStart(pad, "0")}`;
}

export const nextEmployeeId = (existing: readonly string[]) => nextCode(existing, "JDX", 3);
export const nextProjectCode = (existing: readonly string[]) => nextCode(existing, "PRJ", 3);
export const nextTaskCode = (existing: readonly string[]) => nextCode(existing, "TSK", 3);

/** Short opaque id for embedded records (checklist lines, milestones, audit rows). */
export function embeddedId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}
