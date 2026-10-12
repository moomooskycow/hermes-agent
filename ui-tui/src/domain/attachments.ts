import type { ComposerToken } from '../app/interfaces.js'
import { PASTE_SNIPPET_RE } from '../protocol/paste.js'

/**
 * Composer tokens are the ONE way deferred content shows up in the input line:
 * a collapsed paste and an attached image both render as `[[ … ]]` sitting in
 * the text the user is editing. They are ordinary characters — arrow keys,
 * backspace, and selection work on them for free — and they carry their real
 * payload out-of-band until submit.
 *
 * Two consequences the rest of the composer relies on:
 *   - Deleting the token is how you drop the thing. Nothing else to click.
 *   - Position in the text is meaningful: the model sees the payload where the
 *     token sat, not stapled to the front of the turn.
 */
export const imageToken = (index: number) => `[[ Image ${index} ]]`

/** Highest image token index handed out so far, so a new one never collides. */
export const nextImageIndex = (tokens: ComposerToken[]) =>
  tokens.reduce((max, t) => (t.kind === 'image' ? Math.max(max, t.index) : max), 0) + 1

/** Tokens whose label is no longer anywhere in the composer text. */
export const droppedTokens = (tokens: readonly ComposerToken[], value: string) => {
  const live = new Set(value.match(PASTE_SNIPPET_RE) ?? [])

  return tokens.filter(t => !live.has(t.label))
}

/**
 * Resolve every token in `value` to what the agent should actually receive.
 *
 * Labels identify payloads, independent of their order in the draft. Repeated
 * occurrences of one label repeat that payload without consuming the resolver.
 *
 * An image token expands to nothing: the gateway already holds the file in
 * `session.attached_images` and splices the real vision content in at submit.
 * The token's job was to show the user where it landed, so it also eats one
 * adjacent space to avoid leaving a gap in the middle of a sentence.
 */
export const expandTokens = (tokens: readonly ComposerToken[]) => {
  const byLabel = new Map(tokens.map(token => [token.label, token]))

  // Trim authored draft margins before expansion, never the pasted body: its
  // first-line indentation and trailing spaces are part of the user's data.
  return (value: string) =>
    value.trim().replace(
      new RegExp(`([ \\t]?)(${PASTE_SNIPPET_RE.source})([ \\t]?)`, 'g'),
      (match, lead: string, label: string, tail: string) => {
        const token = byLabel.get(label)

        if (!token) {
          return match
        }

        return token.kind === 'paste' ? lead + token.text + tail : lead && tail ? lead : ''
      }
    )
}

/** Syntax inside a pasted preview is data, just like its hidden full body. */
export const composerSyntax = (value: string, tokens: readonly ComposerToken[]) => {
  const labels = new Set(tokens.map(token => token.label))

  return value.replace(PASTE_SNIPPET_RE, label => (labels.has(label) ? ' '.repeat(label.length) : label))
}
