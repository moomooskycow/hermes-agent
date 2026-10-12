import { looksLikeSlashCommand, parseSlashCommand } from '@hermes/shared/slash'
import { type MutableRefObject, useCallback, useEffect, useRef } from 'react'

import { TYPING_IDLE_MS } from '../config/timing.js'
import { composerSyntax, expandTokens } from '../domain/attachments.js'
import { completionToApplyOnSubmit } from '../domain/slash.js'
import type { GatewayClient } from '../gatewayClient.js'
import type { SessionSteerResponse, ShellExecResponse } from '../gatewayTypes.js'
import { queueItem, type QueueItem } from '../hooks/useQueue.js'
import { asRpcResult } from '../lib/rpc.js'
import { hasInterpolation, INTERPOLATION_RE } from '../protocol/interpolation.js'
import type { Msg } from '../types.js'

import type { ComposerActions, ComposerRefs, ComposerState, ComposerToken } from './interfaces.js'
import { submitPrompt } from './submissionCore.js'
import { turnController } from './turnController.js'
import { getUiState, patchUiState } from './uiStore.js'

const DOUBLE_ENTER_MS = 450

const spliceMatches = (text: string, matches: RegExpMatchArray[], results: string[]) =>
  matches.reduceRight((acc, m, i) => acc.slice(0, m.index!) + results[i] + acc.slice(m.index! + m[0].length), text)

export const expandPasteTokens = (tokens: readonly ComposerToken[]) =>
  expandTokens(tokens.filter(token => token.kind === 'paste'))

const slashArgument = (command: string) => /^\/\S+\s+([\s\S]+)$/.exec(command)?.[1] ?? ''

export const queueItemFromSlash = (displayCommand: string, tokens: readonly ComposerToken[]): QueueItem | undefined => {
  const display = slashArgument(displayCommand)

  if (!display.trim()) {
    return undefined
  }

  return prepareSubmission(display, tokens)
}

export const prepareSubmission = (display: string, tokens: readonly ComposerToken[]): QueueItem =>
  queueItem(expandTokens(tokens)(display), display, tokens.filter(token => display.includes(token.label)))

/**
 * Split a slash submission into the two things it has to be at once.
 *
 * A slash command's argument is ordinary user text, so a collapsed paste in it
 * must resolve BEFORE the command runs — otherwise `/pr-triage [[ … [412 lines]
 * … ]]` hands the skill the label and the agent faithfully reports that the
 * paste is truncated. The transcript still shows the compact form, because a
 * 412-line paste inlined into the scrollback is exactly what collapsing it was
 * for.
 *
 * Image tokens stay as labels: the gateway already holds those files in
 * `attached_images` and splices them in at submit.
 */
export const prepareSlashSubmission = (display: string, tokens: readonly ComposerToken[]) => ({
  command: expandPasteTokens(tokens)(display),
  display
})

export const shouldInterpolateSubmission = (display: string, tokens: readonly ComposerToken[] = []) =>
  hasInterpolation(composerSyntax(display, tokens))

export function useSubmission(opts: UseSubmissionOptions): UseSubmissionResult {
  const { appendMessage, composerActions, composerRefs, composerState, gw, setLastUserMsg, slashRef, submitRef, sys } =
    opts

  const lastEmptyAt = useRef(0)
  const typingIdleTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (typingIdleTimer.current) {
      clearTimeout(typingIdleTimer.current)
      typingIdleTimer.current = null
    }

    if (!composerState.input && !composerState.inputBuf.length) {
      turnController.relaxStreaming()

      return
    }

    if (getUiState().busy) {
      turnController.boostStreamingForTyping()
    }

    typingIdleTimer.current = setTimeout(() => {
      typingIdleTimer.current = null
      turnController.relaxStreaming()
    }, TYPING_IDLE_MS)

    return () => {
      if (typingIdleTimer.current) {
        clearTimeout(typingIdleTimer.current)
        typingIdleTimer.current = null
      }
    }
  }, [composerState.input, composerState.inputBuf])

  const send = useCallback(
    (
      text: string,
      showUserMessage = true,
      displayText?: string,
      expandOverride?: (value: string) => string,
      submitOpts: SubmissionSendOptions = {}
    ) => {
      // Snapshot before async file-drop detection or composer clearing. Retries
      // are resolved prompts, not another opportunity to interpret pasted data.
      const tokens = submitOpts.tokens ?? [...composerRefs.tokensRef.current]
      const expand = expandOverride ?? expandTokens(tokens)

      submitPrompt(
        text,
        {
          appendMessage,
          enqueue: (resolved, display) => composerActions.enqueue(queueItem(resolved, display, tokens, 'literal')),
          expand,
          gw,
          setLastUserMsg,
          sys
        },
        showUserMessage,
        displayText,
        submitOpts
      )
    },
    [appendMessage, composerActions, composerRefs, gw, setLastUserMsg, sys]
  )

  const shellExec = useCallback(
    (cmd: string) => {
      appendMessage({ role: 'user', text: `!${cmd}` })
      patchUiState({ busy: true, status: 'running…' })

      gw.request<ShellExecResponse>('shell.exec', { command: cmd })
        .then(raw => {
          const r = asRpcResult<ShellExecResponse>(raw)

          if (!r) {
            return sys('error: invalid response: shell.exec')
          }

          const out = [r.stdout, r.stderr].filter(Boolean).join('\n').trim()

          if (out) {
            sys(out)
          }

          if (r.code !== 0 || !out) {
            sys(`exit ${r.code}`)
          }
        })
        .catch((e: Error) => sys(`error: ${e.message}`))
        .finally(() => patchUiState({ busy: false, status: 'ready' }))
    },
    [appendMessage, gw, sys]
  )

  const interpolate = useCallback(
    (item: QueueItem, then: (result: QueueItem) => void) => {
      patchUiState({ status: 'interpolating…' })
      // Keep offsets into the authored display while masking all paste previews.
      // Shell-looking bytes in either a preview or its full payload are data.
      const matches = [...composerSyntax(item.display, item.tokens).matchAll(new RegExp(INTERPOLATION_RE.source, 'g'))]

      Promise.all(
        matches.map(m =>
          gw
            .request<ShellExecResponse>('shell.exec', {
              command: expandPasteTokens(item.tokens)(item.display.slice(m.index! + 2, m.index! + m[0].length - 1))
            })
            .then(raw => {
              const r = asRpcResult<ShellExecResponse>(raw)

              return [r?.stdout, r?.stderr].filter(Boolean).join('\n').trim()
            })
            .catch(() => '(error)')
        )
      ).then(results => {
        const display = spliceMatches(item.display, matches, results)
        const resolved = prepareSubmission(display, item.tokens)
        then({ ...resolved, interpretation: 'literal' })
      })
    },
    [gw]
  )

  const sendQueued = useCallback(
    (item: QueueItem) => {
      if (item.interpretation === 'composer') {
        const syntax = composerSyntax(item.display, item.tokens)

        if (syntax.startsWith('!')) {
          return shellExec(item.text.slice(1).trim())
        }

        if (hasInterpolation(syntax)) {
          patchUiState({ busy: true })

          return interpolate(item, resolved =>
            send(resolved.text, true, resolved.display, value => value, { tokens: resolved.tokens })
          )
        }
      }

      send(item.text, true, item.display, value => value, { tokens: item.tokens })
    },
    [interpolate, send, shellExec]
  )

  // Honors `display.busy_input_mode` from config.yaml (CLI parity):
  //   - 'queue'     (legacy): append to queueRef; drains on busy → false
  //   - 'steer'     : inject into the current turn via session.steer; falls
  //                   back to queue when steer is rejected (no agent / no
  //                   tool window).
  //   - 'interrupt' (default): submit immediately; the backend redirects the
  //                   active model request (or safely steers after a tool),
  //                   with legacy interrupt + queue as its compatibility path.
  //
  // `opts.fallbackToFront` re-inserts at the queue head (queue-edit picks keep
  // their position); the mainline submit path appends.
  const handleBusyInput = useCallback<(item: QueueItem, opts?: { fallbackToFront?: boolean }) => void>(
    (item: QueueItem, opts: { fallbackToFront?: boolean } = {}) => {
      const live = getUiState()
      const mode = live.busyInputMode

      const enqueueText = () => {
        if (opts.fallbackToFront) {
          composerActions.prependQueue(item)
        } else {
          composerActions.enqueue(item)
        }
      }

      const fallback = (note: string) => {
        enqueueText()
        sys(note)
      }

      if (mode === 'queue') {
        return enqueueText()
      }

      if (item.interpretation === 'composer' && shouldInterpolateSubmission(item.display, item.tokens)) {
        return interpolate(item, resolved => handleBusyInput(resolved, opts))
      }

      if (mode === 'steer' && live.sid) {
        const unconfirmed = () => {
          // A failed/lost ACK does not undo input already consumed by the agent.
          // Keep recovery manual instead of replaying it on the next settle edge.
          if (opts.fallbackToFront) {
            composerActions.pushHistory(item.text)
          }

          patchUiState({ status: 'steer delivery unconfirmed' })
          sys(
            'steer delivery UNCONFIRMED — acknowledgement unavailable; inspect the current turn before repeating. Full input is saved in history.'
          )
        }

        gw.request<SessionSteerResponse>('session.steer', { session_id: live.sid, text: item.text })
          .then(raw => {
            const r = asRpcResult<SessionSteerResponse>(raw)

            if (r?.status === 'rejected') {
              fallback('steer rejected — message queued for next turn')
            } else if (r?.status !== 'queued') {
              unconfirmed()
            }
          })
          .catch(unconfirmed)

        return
      }

      // The gateway owns the atomic redirect decision because it knows whether
      // the agent is in model generation, tool execution, or an older runtime.
      // Reuse the normal submit pipeline so the correction gets its user bubble
      // and file-drop interpolation exactly once.
      send(item.text, true, item.display, value => value, { tokens: item.tokens })
    },
    [composerActions, gw, interpolate, send, sys]
  )

  const dispatchQueued = useCallback(
    (item: QueueItem, opts: { fallbackToFront?: boolean } = {}) => {
      if (item.interpretation === 'composer' && composerSyntax(item.display, item.tokens).startsWith('!')) {
        return sendQueued(item)
      }

      if (!getUiState().sid) {
        return composerActions.enqueue(item)
      }

      if (getUiState().busy) {
        return handleBusyInput(item, opts)
      }

      sendQueued(item)
    },
    [composerActions, handleBusyInput, sendQueued]
  )

  const dispatchSubmission = useCallback(
    (full: string) => {
      if (!full.trim()) {
        return
      }

      const editIdx = composerRefs.queueEditRef.current
      const editedItem = editIdx === null ? undefined : composerRefs.queueRef.current[editIdx]
      const submissionTokens = [...(editedItem?.tokens ?? []), ...composerRefs.tokensRef.current]
      const submission = prepareSubmission(full, submissionTokens)
      if (editedItem?.interpretation === 'literal' && full === editedItem.display) {
        submission.interpretation = 'literal'
      }

      // History is self-contained after tokens clear. Queue items retain both
      // compact display and resolved content, plus protected spans for editing.
      const syntax = composerSyntax(full, submissionTokens)
      const picked = editIdx === null ? submission : composerActions.takeQueue(editIdx, submission)
      composerActions.clearIn()

      if (!picked) {
        return
      }
      if (submission.interpretation === 'composer' && looksLikeSlashCommand(syntax)) {
        const slash = prepareSlashSubmission(full, submissionTokens)

        appendMessage({ kind: 'slash', role: 'system', text: slash.display })
        composerActions.pushHistory(submission.text)

        const parsed = parseSlashCommand(full)

        const queued =
          parsed.name === 'queue' || parsed.name === 'q'
            ? queueItemFromSlash(slash.display, submissionTokens)
            : undefined

        if (queued) {
          composerActions.enqueue(queued)
          sys(`queued: "${queued.display.slice(0, 50)}${queued.display.length > 50 ? '…' : ''}"`)
        } else {
          slashRef.current(slash.command)
        }

        return
      }

      if (submission.interpretation === 'composer' && syntax.startsWith('!')) {
        return sendQueued(picked)
      }

      if (editIdx === null) {
        composerActions.pushHistory(submission.text)
      }

      dispatchQueued(picked, { fallbackToFront: editIdx !== null })
    },
    [
      appendMessage,
      composerActions,
      composerRefs,
      dispatchQueued,
      sendQueued,
      slashRef,
      sys
    ]
  )

  const submit = useCallback(
    (value: string) => {
      if (composerState.completions.length) {
        const row = composerState.completions[composerState.compIdx]
        const next = completionToApplyOnSubmit(value, row?.text, composerState.compReplace)

        if (next !== null) {
          return composerActions.setInput(next)
        }
      }

      if (!value.trim() && !composerState.inputBuf.length) {
        const live = getUiState()
        const now = Date.now()
        const doubleTap = now - lastEmptyAt.current < DOUBLE_ENTER_MS
        lastEmptyAt.current = now

        if (doubleTap && live.busy && live.sid) {
          // Force-send: keep busy when a message is queued so the settle edge
          // drains it once (no race). Empty queue = plain Stop → 'ready'.
          const hasQueued = composerRefs.queueRef.current.length > 0

          return turnController.interruptTurn({ appendMessage, gw, sid: live.sid, sys }, { keepBusy: hasQueued })
        }

        if (doubleTap && live.sid && composerRefs.queueRef.current.length) {
          const next = composerActions.dequeue()

          if (next) {
            composerActions.setQueueEdit(null)
            dispatchQueued(next)
          }
        }

        return
      }

      lastEmptyAt.current = 0

      if (value.endsWith('\\')) {
        composerActions.setInputBuf(prev => [...prev, value.slice(0, -1)])

        return composerActions.setInput('')
      }

      dispatchSubmission([...composerState.inputBuf, value].join('\n'))
    },
    [appendMessage, composerActions, composerRefs, composerState, dispatchQueued, dispatchSubmission, gw, sys]
  )

  submitRef.current = submit

  // Literal submission: route text straight to the prompt pipeline, skipping
  // slash-command routing, `!` shell dispatch, [[token]] expansion, and
  // {!...} interpolation. Startup `-q` queries use this — they're arbitrary
  // launcher/script text, and one-shot mode already treats them literally.
  const submitLiteral = useCallback(
    (value: string) => {
      if (!value.trim()) {
        return
      }

      send(value, true, value, v => v, { skipDetectDrop: true, tokens: [] })
    },
    [send]
  )

  return { dispatchQueued, dispatchSubmission, send, sendQueued, submit, submitLiteral }
}

export interface UseSubmissionOptions {
  appendMessage: (msg: Msg) => void
  composerActions: ComposerActions
  composerRefs: ComposerRefs
  composerState: ComposerState
  gw: GatewayClient
  setLastUserMsg: (value: string) => void
  slashRef: MutableRefObject<(cmd: string) => boolean>
  submitRef: MutableRefObject<(value: string) => void>
  sys: (text: string) => void
}

export interface SubmissionSendOptions {
  skipDetectDrop?: boolean
  tokens?: readonly ComposerToken[]
}

export interface UseSubmissionResult {
  dispatchQueued: (item: QueueItem) => void
  dispatchSubmission: (full: string) => void
  send: (
    text: string,
    showUserMessage?: boolean,
    displayText?: string,
    expandOverride?: (value: string) => string,
    submitOpts?: SubmissionSendOptions
  ) => void
  sendQueued: (item: QueueItem) => void
  submit: (value: string) => void
  submitLiteral: (value: string) => void
}
