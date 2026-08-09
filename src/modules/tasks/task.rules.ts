import type { Priority, TaskState } from "@prisma/client";

/*
 * The task maths, in one place.
 *
 * These are ports of lib/store/selectors.ts in the frontend, deliberately
 * identical so a number the server returns is the number the old build showed.
 * They are pure — no Prisma, no request — so the QC flow and the project
 * progress calculation can both use them.
 */

export type ChecklistLine = { id: string; label: string; done: boolean; score: number; points: number };

/** 0..1. NaN reads as 0, which is what an empty input field produces. */
export function clampScore(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(Math.max(n, 0), 1);
}

/** Tolerates lines saved before `points` existed — one point is the neutral default. */
export function itemPoints(item: { points?: number | null }): number {
  const n = Number(item.points);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

/** Mean checklist score as a percentage. An empty checklist scores 0. */
export function taskScore(checklist: readonly { score: number }[]): number {
  if (checklist.length === 0) return 0;
  const sum = checklist.reduce((n, c) => n + clampScore(c.score), 0);
  return Math.round((sum / checklist.length) * 100);
}

export function checklistDone(checklist: readonly { score: number }[]): number {
  return checklist.filter((c) => clampScore(c.score) >= 1).length;
}

export function checklistPoints(checklist: readonly { points?: number | null }[]): number {
  return checklist.reduce((n, c) => n + itemPoints(c), 0);
}

/** What an Error verdict on this subset would cost EACH assignee. */
export function pointsFor(
  checklist: readonly { id: string; points?: number | null }[],
  itemIds: Iterable<string>,
): number {
  const wanted = new Set(itemIds);
  return checklist.reduce((n, c) => (wanted.has(c.id) ? n + itemPoints(c) : n), 0);
}

/** KRA is a 0–100 scale; repeated deductions must never run it negative. */
export function clampKra(n: number): number {
  return Math.min(Math.max(Math.round(n), 0), 100);
}

/** `done` is the canonical field; `score` is the frontend's. Keep them agreeing. */
export function normaliseLine(line: {
  id: string;
  label: string;
  done?: boolean;
  score?: number | null;
  points?: number | null;
}): ChecklistLine {
  const score = clampScore(Number(line.score ?? (line.done ? 1 : 0)));
  return {
    id: line.id,
    label: line.label,
    score,
    points: itemPoints(line),
    done: score >= 1,
  };
}

/* --------------------------------------------------------------- mapping -- */

/**
 * The frontend orders work P1..P5; the canonical model has a four-value enum.
 * Both are stored — `priorityLevel` is what the UI sorts on, `priority` is what
 * the schema specifies — and this is the single conversion between them.
 */
export function priorityFromLevel(level: number): Priority {
  if (level <= 1) return "urgent";
  if (level === 2) return "high";
  if (level === 3) return "medium";
  return "low";
}

export function levelFromPriority(priority: Priority): number {
  switch (priority) {
    case "urgent":
      return 1;
    case "high":
      return 2;
    case "medium":
      return 3;
    default:
      return 4;
  }
}

/** States that count as open work for the `openWork` counter on a user. */
export function isOpenState(state: TaskState): boolean {
  return state !== "done";
}
