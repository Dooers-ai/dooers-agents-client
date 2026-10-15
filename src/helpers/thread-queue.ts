/** ``thread.list`` sentinel for threads with no queue. Not a valid catalog slug. */
export const UNQUEUED_QUEUE_FILTER = '__none__'

export function isUnqueuedQueueFilter(queue: string | null | undefined): boolean {
  return queue === UNQUEUED_QUEUE_FILTER
}
