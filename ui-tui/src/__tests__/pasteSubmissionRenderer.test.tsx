import { PassThrough } from 'node:stream'
import { setImmediate as nextTick } from 'node:timers/promises'

import { JsonRpcGatewayError } from '@hermes/shared/json-rpc-channel'
import { renderSync, Text } from '@hermes/ink'
import React, { useRef } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { UseComposerStateResult } from '../app/interfaces.js'
import { useComposerState } from '../app/useComposerState.js'
import { useSubmission, type UseSubmissionResult } from '../app/useSubmission.js'
import { patchUiState, resetUiState } from '../app/uiStore.js'
import type { GatewayClient } from '../gatewayClient.js'

// History persistence is unrelated to prompt delivery; never write the operator's
// actual history while mounting the real composer and submission hooks.
vi.mock('../lib/history.js', () => ({ append: vi.fn(), load: () => [] }))

const note = [
  'In plain English, preserve this entire note.',
  ...Array.from({ length: 17 }, (_, index) =>
    index === 8 ? 'MIDDLE_SENTINEL_19_LINE_NOTE' : `Acceptance detail ${index + 1}`
  ),
  'Quote acceptance? nps? etc'
].join('\n')

const mounted: Array<() => void> = []
afterEach(() => {
  for (const unmount of mounted.splice(0)) {
    unmount()
  }

  resetUiState()
})

function mountSubmission(respond: (method: string, params: Record<string, unknown>) => unknown = () => undefined) {
  resetUiState()
  patchUiState({ pasteCollapseChars: 0, pasteCollapseLines: 3, sid: 'paste-session' })
  const calls: Array<{ method: string; params: Record<string, unknown> }> = []
  const bubbles: string[] = []
  const sys = vi.fn()
  const gw = {
    request: vi.fn(async (method: string, params: Record<string, unknown> = {}) => {
      calls.push({ method, params })
      const response = respond(method, params)

      if (response !== undefined) {
        return response
      }

      if (method === 'input.detect_drop') {
        return { matched: false }
      }

      if (method === 'session.steer') {
        return { status: 'queued' }
      }

      return { status: 'streaming' }
    })
  } as unknown as GatewayClient
  let composer!: UseComposerStateResult
  let submission!: UseSubmissionResult

  function Harness() {
    const submitRef = useRef<(value: string) => void>(() => {})
    const slashRef = useRef<(value: string) => boolean>(vi.fn(() => true))
    composer = useComposerState({ gw, submitRef, sys })
    submission = useSubmission({
      appendMessage: message => {
        if (message.role === 'user') {
          bubbles.push(message.text)
        }
      },
      composerActions: composer.actions,
      composerRefs: composer.refs,
      composerState: composer.state,
      gw,
      setLastUserMsg: vi.fn(),
      slashRef,
      submitRef,
      sys
    })

    return <Text>{composer.state.input || 'empty composer'}</Text>
  }

  const stdout = new PassThrough()
  Object.assign(stdout, { columns: 100, isTTY: false, rows: 24 })
  stdout.resume()
  const instance = renderSync(<Harness />, {
    patchConsole: false,
    stdin: new PassThrough() as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
    stderr: new PassThrough() as unknown as NodeJS.WriteStream
  })
  mounted.push(() => instance.unmount())

  return {
    bubbles,
    calls,
    get composer() {
      return composer
    },
    get submission() {
      return submission
    },
    sys,
    async paste(text: string, value = '', cursor = value.length) {
      const pasted = await composer.actions.handleTextPaste({ bracketed: true, cursor, text, value })
      expect(pasted).not.toBeNull()
      composer.actions.setInput(pasted!.value)

      return pasted!.value
    },
    texts(method: string) {
      return calls.filter(call => call.method === method).map(call => call.params.text)
    }
  }
}

describe('native composer paste delivery', () => {
  it.each([
    { busy: false, method: 'prompt.submit', mode: 'interrupt' as const },
    { busy: true, method: 'prompt.submit', mode: 'interrupt' as const },
    { busy: true, method: 'session.steer', mode: 'steer' as const }
  ])('delivers all 19 lines through $mode, busy=$busy', async ({ busy, method, mode }) => {
    const app = mountSubmission()
    patchUiState({ busy, busyInputMode: mode })
    const display = await app.paste(note)
    expect(display).toContain('[19 lines]')
    expect(display).not.toContain('MIDDLE_SENTINEL_19_LINE_NOTE')

    // Paste and Enter can arrive before React commits another render.
    app.submission.submit(display)

    await expect.poll(() => app.texts(method)).toEqual([note])
    expect(app.composer.refs.tokensRef.current).toEqual([])
    expect(app.calls.some(call => call.method === 'shell.exec')).toBe(false)
    if (method === 'prompt.submit') {
      expect(app.bubbles).toEqual([display])
    }
  })

  it('keeps the resolved paste on an explicitly refused busy steer and its next-turn drain', async () => {
    const app = mountSubmission(method => (method === 'session.steer' ? { status: 'rejected' } : undefined))
    patchUiState({ busy: true, busyInputMode: 'steer' })
    const display = await app.paste(note)
    app.submission.submit(display)

    await expect.poll(() => app.composer.refs.queueRef.current.map(item => item.text)).toEqual([note])
    expect(app.composer.refs.queueRef.current.map(item => item.display)).toEqual([display])
    patchUiState({ busy: false })
    const next = app.composer.actions.dequeue()
    expect(next).toBeDefined()
    app.submission.sendQueued(next!)

    await expect.poll(() => app.texts('prompt.submit')).toEqual([note])
    expect(app.bubbles).toEqual([display])
  })

  it.each([4001, 4002, 4010])('queues a complete paste after definite steer refusal %s', async code => {
    const app = mountSubmission(method => {
      if (method === 'session.steer') {
        throw new JsonRpcGatewayError('steer refused before acceptance', { code })
      }
    })
    patchUiState({ busy: true, busyInputMode: 'steer' })
    app.submission.submit(await app.paste(note))
    await expect.poll(() => app.composer.refs.queueRef.current.map(item => item.text)).toEqual([note])
    patchUiState({ busy: false })
    app.submission.sendQueued(app.composer.actions.dequeue()!)
    await expect.poll(() => app.texts('prompt.submit')).toEqual([note])
    expect(app.sys).not.toHaveBeenCalledWith(expect.stringContaining('UNCONFIRMED'))
  })

  it('submits resolved busy interpolation if the turn settles before the command returns', async () => {
    const { promise: commandResult, resolve } = Promise.withResolvers<unknown>()
    const app = mountSubmission(method => method === 'shell.exec' ? commandResult : undefined)
    patchUiState({ busy: true, busyInputMode: 'steer' })
    app.submission.submit(await app.paste(note, 'Typed {!printf RESULT} '))
    patchUiState({ busy: false })
    resolve({ code: 0, stderr: '', stdout: 'RESULT' })
    await expect.poll(() => app.texts('prompt.submit')).toEqual([`Typed RESULT ${note}`])
    expect(app.texts('session.steer')).toEqual([])
    expect(app.composer.refs.queueRef.current).toEqual([])
  })

  it('preserves queue-owned images while editing and detaches deleted images when the edit is accepted', async () => {
    const app = mountSubmission()
    patchUiState({ busy: true, busyInputMode: 'queue' })
    const image = { index: 1, kind: 'image' as const, label: '[[ Image 1 ]]', path: '/queued.png' }
    const draft = { index: 1, kind: 'image' as const, label: '[[ Image 1 ]]', path: '/draft.png' }
    app.composer.actions.setComposerTokens([image])
    app.submission.submit(`Queued ${image.label}`)
    app.composer.actions.setComposerTokens([draft])
    app.composer.actions.syncTokens(`Queued ${image.label}`, [image])
    expect(app.calls.filter(call => call.method === 'image.detach').map(call => call.params.path)).toEqual(['/draft.png'])
    app.composer.actions.setQueueEdit(0)
    app.composer.actions.setComposerTokens([image])
    app.composer.actions.syncTokens('Edited without image')
    expect(app.calls.filter(call => call.method === 'image.detach').map(call => call.params.path)).toEqual(['/draft.png'])
    app.submission.submit('Edited without image')
    expect(app.calls.filter(call => call.method === 'image.detach').map(call => call.params.path)).toEqual(['/draft.png', '/queued.png'])
    expect(app.composer.refs.queueRef.current[0]!.tokens).toEqual([])
  })

  it('does not accumulate token copies through repeated queue edits', async () => {
    const app = mountSubmission()
    patchUiState({ busy: true, busyInputMode: 'queue' })
    app.submission.submit(await app.paste(note))
    for (let cycle = 0; cycle < 8; cycle++) {
      const item = app.composer.refs.queueRef.current[0]!
      app.composer.actions.setQueueEdit(0)
      app.composer.actions.setComposerTokens([...item.tokens])
      app.submission.submit(item.display)
    }
    expect(app.composer.refs.queueRef.current[0]!.tokens).toHaveLength(1)
    patchUiState({ busy: false })
    app.submission.sendQueued(app.composer.actions.dequeue()!)
    await expect.poll(() => app.texts('prompt.submit')).toEqual([note])
  })

  it('does not resend a steer consumed before its acknowledgement is lost', async () => {
    const admitted: unknown[] = []
    const { promise: acknowledgement, reject: rejectAck } = Promise.withResolvers<unknown>()
    const app = mountSubmission((method, params) => {
      if (method === 'session.steer') {
        admitted.push(params.text)

        return acknowledgement
      }
    })
    patchUiState({ busy: true, busyInputMode: 'steer' })
    const prompt = 'ACK_LOST_BODY_MIDDLE_SENTINEL'
    app.submission.submit(prompt)
    expect(admitted).toEqual([prompt])

    // The live agent already consumed this input; a missing ACK cannot undo it.
    rejectAck(new Error('RPC request timed out'))
    await expect.poll(() => app.sys.mock.calls.length).toBeGreaterThan(0)
    patchUiState({ busy: false })
    const next = app.composer.actions.dequeue()
    if (next) {
      app.submission.sendQueued(next)
    }

    await nextTick()
    expect(app.texts('prompt.submit')).toEqual([])
    expect(admitted).toEqual([prompt])
    expect(app.composer.refs.queueRef.current).toEqual([])
    expect(app.sys).toHaveBeenCalledWith(expect.stringContaining('UNCONFIRMED'))
  })

  it.each(['busy queue', 'no session'] as const)('retains compact display and full payload through %s', async route => {
    const app = mountSubmission()
    patchUiState({ busy: route === 'busy queue', busyInputMode: 'queue', sid: route === 'no session' ? null : 'paste-session' })
    const display = await app.paste(note)
    app.submission.submit(display)

    expect(app.composer.refs.queueRef.current.map(item => item.text)).toEqual([note])
    expect(app.composer.refs.queueRef.current.map(item => item.display)).toEqual([display])
    expect(app.composer.refs.tokensRef.current).toEqual([])
    patchUiState({ busy: false, sid: 'paste-session' })
    app.submission.sendQueued(app.composer.actions.dequeue()!)

    await expect.poll(() => app.texts('prompt.submit')).toEqual([note])
    expect(app.bubbles).toEqual([display])
  })

  it.each(['/queue', '/q'])('resolves a paste once through the %s command and drain', async command => {
    const app = mountSubmission()
    const display = await app.paste(note, `${command} `)
    app.submission.submit(display)
    expect(app.composer.refs.queueRef.current.map(item => item.text)).toEqual([note])
    expect(app.texts('prompt.submit')).toEqual([])
    app.submission.sendQueued(app.composer.actions.dequeue()!)

    await expect.poll(() => app.texts('prompt.submit')).toEqual([note])
    expect(app.bubbles).toEqual([display.slice(command.length + 1)])
  })

  it.each(['idle', 'queue', 'steer', 'interrupt'] as const)('restores queued paste identities through %s edits and a newly pasted body', async route => {
    const app = mountSubmission()
    patchUiState({ busy: true, busyInputMode: 'queue' })
    const original = await app.paste(note, 'Original framing: ')
    app.submission.submit(original)
    const queued = app.composer.refs.queueRef.current[0]!
    app.composer.actions.setQueueEdit(0)
    app.composer.actions.setComposerTokens([...queued.tokens])
    const edited = queued.display.replace('Original framing:', 'Edited framing:')
    app.composer.actions.setInput(edited)
    const second = note.replace('MIDDLE_SENTINEL_19_LINE_NOTE', 'SECOND_MIDDLE_SENTINEL')
    const withSecondPaste = await app.paste(second, edited)
    patchUiState({ busy: route !== 'idle', busyInputMode: route === 'idle' ? 'interrupt' : route })
    app.submission.submit(withSecondPaste)
    if (route === 'queue') {
      expect(app.composer.refs.queueRef.current[0]!.text).toBe(`Edited framing: ${note} ${second}`)
      patchUiState({ busy: false })
      app.submission.sendQueued(app.composer.actions.dequeue()!)
    }

    await expect.poll(() => app.texts(route === 'steer' ? 'session.steer' : 'prompt.submit')).toEqual([
      `Edited framing: ${note} ${second}`
    ])
    if (route !== 'steer') {
      expect(app.bubbles).toEqual([withSecondPaste])
    }
    expect(app.composer.refs.queueRef.current).toEqual([])
  })

  it('keeps same-preview pastes distinct after reordering, duplication and deletion', async () => {
    const app = mountSubmission()
    const other = note.replace('MIDDLE_SENTINEL_19_LINE_NOTE', 'OTHER_MIDDLE_SENTINEL')
    const firstLabel = await app.paste(note)
    await app.paste(other, firstLabel)
    const secondLabel = app.composer.refs.tokensRef.current[1]!.label
    expect(secondLabel).not.toBe(firstLabel)
    app.composer.actions.setInput(`${secondLabel} ${firstLabel} ${secondLabel}`)
    app.submission.submit(`${secondLabel} ${firstLabel} ${secondLabel}`)

    await expect.poll(() => app.texts('prompt.submit')).toEqual([`${other} ${note} ${other}`])
    patchUiState({ busy: false })
    const thirdLabel = await app.paste(note)
    await app.paste(other, thirdLabel)
    const fourthLabel = app.composer.refs.tokensRef.current[1]!.label
    app.composer.actions.syncTokens(fourthLabel)
    app.composer.actions.setInput(fourthLabel)
    app.submission.submit(fourthLabel)

    await expect.poll(() => app.texts('prompt.submit')).toEqual([`${other} ${note} ${other}`, other])
  })

  it('does not evict any of 34 still-visible paste payloads', async () => {
    const app = mountSubmission()
    const bodies = Array.from({ length: 34 }, (_, index) => `First ${index}\nRETAINED_MIDDLE_${index}\nLast ${index}`)
    let display = ''
    for (const body of bodies) {
      display = await app.paste(body, display)
    }

    expect(app.composer.refs.tokensRef.current).toHaveLength(34)
    app.submission.submit(display)

    await expect.poll(() => app.texts('prompt.submit')).toEqual([bodies.join(' ')])
  })

  it('retains a multi-megabyte paste while its compact label remains visible', async () => {
    const app = mountSubmission()
    const body = `First line\n${'x'.repeat(4 * 1024 * 1024)}\nLARGE_PASTE_MIDDLE_SENTINEL\nLast line`
    const display = await app.paste(body)
    expect(app.composer.refs.tokensRef.current).toHaveLength(1)
    app.submission.submit(display)

    await expect.poll(() => app.texts('prompt.submit')[0] === body).toBe(true)
    expect(app.bubbles).toEqual([display])
  })

  it('retains a paste in a continued input line when the current line is edited', async () => {
    const app = mountSubmission()
    const display = await app.paste(note)
    app.composer.actions.setInputBuf([display])
    app.composer.actions.setInput('continued line')
    app.composer.actions.syncTokens('continued line')
    expect(app.composer.refs.tokensRef.current).toHaveLength(1)
    await expect.poll(() => app.composer.state.inputBuf).toEqual([display])
    app.submission.submit('continued line')

    await expect.poll(() => app.texts('prompt.submit')).toEqual([`${note}\ncontinued line`])
  })

  it.each(['!printf PASTED_SHELL_DATA', '  !printf PASTED_SHELL_DATA', 'Reported {!printf PASTED_INTERPOLATION_DATA}'])(
    'treats short pasted executable-looking syntax as literal data: %s',
    async body => {
      const app = mountSubmission()
      const display = await app.paste(body)
      app.submission.submit(display)

      await expect.poll(() => app.texts('prompt.submit')).toEqual([body])
      expect(app.calls.filter(call => call.method === 'shell.exec')).toEqual([])
    }
  )

  it.each(['queue', 'steer', 'interrupt'] as const)('never executes pasted syntax through busy %s', async mode => {
    const app = mountSubmission()
    const body = '!printf PASTED_SHELL_DATA\nPASTED_SYNTAX_MIDDLE_SENTINEL\n{!printf PASTED_INTERPOLATION_DATA}'
    patchUiState({ busy: true, busyInputMode: mode })
    const display = await app.paste(body)
    app.submission.submit(display)
    if (mode === 'queue') {
      expect(app.composer.refs.queueRef.current[0]!.text).toBe(body)
      patchUiState({ busy: false })
      app.submission.sendQueued(app.composer.actions.dequeue()!)
    }

    await expect.poll(() => app.texts(mode === 'steer' ? 'session.steer' : 'prompt.submit')).toEqual([body])
    expect(app.calls.filter(call => call.method === 'shell.exec')).toEqual([])
  })

  it.each(['idle', 'queue', 'steer', 'interrupt', 'refused steer'] as const)(
    'executes only authored interpolation alongside pasted syntax through %s',
    async route => {
      const app = mountSubmission(method => {
        if (method === 'shell.exec') {
          return { code: 0, stderr: '', stdout: 'TYPED_INTERPOLATION_RESULT' }
        }
        if (method === 'session.steer' && route === 'refused steer') {
          return { status: 'rejected' }
        }
      })
      const body = 'Copied {!printf PASTED_ONLY}\nINTERPOLATION_MIDDLE_SENTINEL\nCopied last line'
      patchUiState({ busy: route !== 'idle', busyInputMode: route === 'idle' ? 'interrupt' : route === 'refused steer' ? 'steer' : route })
      const display = await app.paste(body, 'Typed value: {!printf TYPED_ONLY} ')
      app.submission.submit(display)
      if (route === 'queue' || route === 'refused steer') {
        if (route === 'queue') {
          expect(app.calls.filter(call => call.method === 'shell.exec')).toEqual([])
        }
        await expect.poll(() => app.composer.refs.queueRef.current.length).toBe(1)
        patchUiState({ busy: false })
        app.submission.sendQueued(app.composer.actions.dequeue()!)
      }

      await expect.poll(() => app.texts(route === 'steer' ? 'session.steer' : 'prompt.submit')).toEqual([
        `Typed value: TYPED_INTERPOLATION_RESULT ${body}`
      ])
      expect(app.calls.filter(call => call.method === 'shell.exec').map(call => call.params.command)).toEqual([
        'printf TYPED_ONLY'
      ])
      if (route !== 'steer') {
        expect(app.bubbles).toEqual([display.replace('{!printf TYPED_ONLY}', 'TYPED_INTERPOLATION_RESULT')])
      }
    }
  )

  it('preserves an intentionally typed queued shell command', async () => {
    const app = mountSubmission(method => (method === 'shell.exec' ? { code: 0, stderr: '', stdout: 'typed' } : undefined))
    app.submission.submit('/queue !printf TYPED_QUEUE_COMMAND')
    app.submission.sendQueued(app.composer.actions.dequeue()!)

    await expect.poll(() => app.calls.filter(call => call.method === 'shell.exec').map(call => call.params.command)).toEqual([
      'printf TYPED_QUEUE_COMMAND'
    ])
    expect(app.texts('prompt.submit')).toEqual([])
  })

  it('keeps confirmed-busy retries literal and compact without executing their pasted payload', async () => {
    let submits = 0
    const app = mountSubmission(method => {
      if (method === 'prompt.submit' && ++submits === 1) {
        throw new Error('session busy')
      }
    })
    const body = '!printf PASTED_SHELL_DATA\nBUSY_RETRY_MIDDLE_SENTINEL\n{!printf PASTED_INTERPOLATION_DATA}'
    const display = await app.paste(body)
    app.submission.submit(display)
    await expect.poll(() => app.composer.refs.queueRef.current.length).toBe(1)
    const queued = app.composer.refs.queueRef.current[0]!
    expect(queued.text).toBe(body)
    expect(queued.display).toBe(display)
    expect(queued.interpretation).toBe('literal')
    expect(queued.tokens[0]!.text).toBe(body)
    patchUiState({ busy: false })
    app.submission.sendQueued(app.composer.actions.dequeue()!)

    await expect.poll(() => app.texts('prompt.submit')).toEqual([body, body])
    expect(app.calls.filter(call => call.method === 'shell.exec')).toEqual([])
    expect(app.bubbles).toEqual([display, display])
  })

  it('allows identical separately submitted pastes without content deduplication', async () => {
    const app = mountSubmission()
    patchUiState({ busy: true, busyInputMode: 'steer' })
    app.submission.submit(await app.paste(note))
    app.submission.submit(await app.paste(note))

    await expect.poll(() => app.texts('session.steer')).toEqual([note, note])
    expect(app.composer.refs.queueRef.current).toEqual([])
  })

  it.each(['ordinary', '/queue'] as const)('preserves pasted indentation and trailing spaces through %s', async route => {
    const app = mountSubmission()
    const body = '    indented first line\n  INDENTED_MIDDLE_SENTINEL\n    indented last line  '
    const display = await app.paste(body, route === '/queue' ? '/queue ' : '')
    app.submission.submit(display)
    if (route === '/queue') {
      app.submission.sendQueued(app.composer.actions.dequeue()!)
    }

    await expect.poll(() => app.texts('prompt.submit')).toEqual([body])
  })
})
