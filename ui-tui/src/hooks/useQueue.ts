import { useStore } from '@nanostores/react'
import { useCallback, useMemo, useRef, useState } from 'react'

import type { ComposerToken } from '../app/interfaces.js'
import { $uiState, getUiState } from '../app/uiStore.js'

export interface QueueItem {
  display: string
  interpretation: 'composer' | 'literal'
  text: string
  readonly tokens: readonly Readonly<ComposerToken>[]
}

export const queueItem = (
  text: string,
  display = text,
  tokens: readonly ComposerToken[] = [],
  interpretation: QueueItem['interpretation'] = 'composer'
): QueueItem => ({ display, interpretation, text, tokens: [...tokens] })

export function prependQueueItem(queue: QueueItem[], item: QueueItem): void {
  queue.unshift(item)
}

export function takeQueueItem(queue: QueueItem[], index: number, edited?: QueueItem): QueueItem | undefined {
  if (index < 0 || index >= queue.length) {
    return undefined
  }

  const [item] = queue.splice(index, 1)

  return edited ?? item
}

// Mutates `arr` in place; returned reference is the same input array, kept
// so callers can chain. Use `Array.prototype.toSpliced` if you need a copy.
export function removeAtInPlace<T>(arr: T[], i: number): T[] {
  if (i < 0 || i >= arr.length) {
    return arr
  }

  arr.splice(i, 1)

  return arr
}

interface PendingQueue {
  edit: number | null
  items: QueueItem[]
}

export function useQueue(): UseQueueResult {
  useStore($uiState)
  const queues = useRef(new Map<string, PendingQueue>())
  const unbound = useRef<PendingQueue>({ edit: null, items: [] })
  const [, refresh] = useState(0)

  const getQueue = useCallback(() => {
    const { sid, info } = getUiState()

    if (!sid) {
      return unbound.current
    }

    const key = JSON.stringify([info?.profile_name || 'default', sid])
    let queue = queues.current.get(key)

    if (!queue) {
      queue = { edit: null, items: [] }
      queues.current.set(key, queue)
    }

    // Input typed before any session exists belongs to the next attachment,
    // unlike a bound session's queue, which must never migrate on navigation.
    if (unbound.current.items.length) {
      const offset = queue.items.length
      queue.items.push(...unbound.current.items)

      if (unbound.current.edit !== null) {
        queue.edit = offset + unbound.current.edit
      }

      unbound.current = { edit: null, items: [] }
    }

    return queue
  }, [])

  // Resolve on access, not in an effect: navigation and a drain can happen
  // before React renders again, including through an older input callback.
  const queueRef = useMemo(
    () => ({
      get current() {
        return getQueue().items
      }
    }),
    [getQueue]
  )

  const queueEditRef = useMemo(
    () => ({
      get current() {
        return getQueue().edit
      },
      set current(value: number | null) {
        getQueue().edit = value
      }
    }),
    [getQueue]
  )

  const queuedDisplay = queueRef.current.map(item => item.display)
  const queueEditIdx = queueEditRef.current
  const syncQueue = useCallback(() => refresh(version => version + 1), [])

  const setQueueEdit = useCallback(
    (idx: number | null) => {
      queueEditRef.current = idx
      syncQueue()
    },
    [queueEditRef, syncQueue]
  )

  const enqueue = useCallback(
    (item: QueueItem) => {
      queueRef.current.push(item)
      syncQueue()
    },
    [queueRef, syncQueue]
  )

  const prependQ = useCallback(
    (item: QueueItem) => {
      prependQueueItem(queueRef.current, item)
      syncQueue()
    },
    [queueRef, syncQueue]
  )

  const dequeue = useCallback(() => {
    const head = queueRef.current.shift()
    syncQueue()

    return head
  }, [queueRef, syncQueue])

  const takeQ = useCallback(
    (i: number, edited?: QueueItem) => {
      const item = takeQueueItem(queueRef.current, i, edited)

      if (item) {
        syncQueue()
      }

      return item
    },
    [queueRef, syncQueue]
  )

  const removeQ = useCallback(
    (i: number) => {
      takeQ(i)
    },
    [takeQ]
  )

  return {
    dequeue,
    enqueue,
    prependQ,
    queueEditIdx,
    queueEditRef,
    queueRef,
    queuedDisplay,
    removeQ,
    setQueueEdit,
    takeQ
  }
}

export interface UseQueueResult {
  dequeue: () => QueueItem | undefined
  enqueue: (item: QueueItem) => void
  prependQ: (item: QueueItem) => void
  queueEditIdx: number | null
  queueEditRef: { current: number | null }
  queueRef: { readonly current: QueueItem[] }
  queuedDisplay: string[]
  removeQ: (index: number) => void
  setQueueEdit: (index: number | null) => void
  takeQ: (index: number, edited?: QueueItem) => QueueItem | undefined
}
