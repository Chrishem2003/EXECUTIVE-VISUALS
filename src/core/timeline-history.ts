export interface TimelineHistoryStacks<T> {
  undo: T[];
  redo: T[];
}

export type TimelineHistoryDirection = "undo" | "redo";

/**
 * Apply an undo/redo transition only when its corresponding save succeeds.
 * The history stacks are restored if persistence rejects, so a revision conflict
 * cannot silently consume a history entry or leave the opposite stack polluted.
 */
export async function applyTimelineHistory<T>(
  current: T,
  history: TimelineHistoryStacks<T>,
  direction: TimelineHistoryDirection,
  persist: (next: T) => Promise<T | void>
): Promise<T> {
  const source = direction === "undo" ? history.undo : history.redo;
  if (!source.length) return current;

  const undoBefore = history.undo.map(value => structuredClone(value));
  const redoBefore = history.redo.map(value => structuredClone(value));
  const next = source.pop() as T;
  const destination = direction === "undo" ? history.redo : history.undo;
  destination.push(structuredClone(current));

  try {
    const saved = await persist(next);
    return saved === undefined ? next : saved;
  } catch (error) {
    history.undo = undoBefore;
    history.redo = redoBefore;
    throw error;
  }
}
