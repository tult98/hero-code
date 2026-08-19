import * as vscode from 'vscode'
import type { SessionItem, Status } from './types.js'
import type { MonitorSnapshot } from './monitor.js'

export type SessionEventKind = 'waiting' | 'finished' | 'error'

/** Something worth telling the user about, resolved to one session. */
export interface SessionEvent {
  kind: SessionEventKind
  id: string
  liveId?: string
  /** Display name — the user's custom name if they set one. */
  title: string
  /** Workspace folder name, for disambiguating identical titles across projects. */
  folder?: string
  /** What Claude is asking / what it just did. Refreshed at delivery time. */
  detail?: string
  /** The outstanding tool_use this `waiting` event refers to, if any. */
  key?: string
}

interface Prev {
  status: Status
  turnCount: number
  /** The pending tool id we last raised a `waiting` event for. */
  firedWaitingFor?: string
  /**
   * True once this session has produced a `turn_duration` marker. Until then we
   * can't tell "this Claude version doesn't write them" from "no turn has
   * finished yet", so the status-edge fallback stays armed.
   */
  usesTurnMarker: boolean
}

/** Permission modes in which Claude approves tools itself. */
const SELF_APPROVING = new Set(['auto', 'acceptEdits', 'bypassPermissions'])

/**
 * Turns successive monitor snapshots into discrete attention events.
 *
 * The hard part is not spotting a `waiting` row — it is *not* firing for the
 * dozens of rows that were already waiting before anyone was listening. Every
 * rule here exists to keep a window reload silent.
 */
export class TransitionDetector {
  private readonly prev = new Map<string, Prev>()
  private primed = false

  detect(snap: MonitorSnapshot): SessionEvent[] {
    const events: SessionEvent[] = []
    const seen = new Set<string>()
    const ignoreAuto = vscode.workspace
      .getConfiguration('heroCode.notifications')
      .get<boolean>('ignoreAutoMode', true)

    for (const group of snap.groups) {
      for (const s of group.sessions) {
        seen.add(s.id)
        const prev = this.prev.get(s.id)
        const next: Prev = {
          status: s.status,
          turnCount: s.turnCount ?? 0,
          firedWaitingFor: prev?.firedWaitingFor,
          usesTurnMarker: (prev?.usesTurnMarker ?? false) || (s.turnCount ?? 0) > 0,
        }

        // Never fire for a row we are seeing for the first time. This covers
        // both the initial scan after activation and a session (or workspace
        // folder) that appears later — in every case the state predates us, so
        // it isn't news.
        if (!prev || !this.primed) {
          this.prev.set(s.id, next)
          continue
        }

        // --- needs input -------------------------------------------------
        if (s.status === 'waiting') {
          const key = s.pendingToolId ?? 'waiting'
          const isQuestion = s.pendingToolName === 'AskUserQuestion'
          // In a self-approving mode Claude answers its own permission prompts,
          // so an outstanding tool call means "slow tool", not "needs you". A
          // real question is asked of the user regardless of mode.
          const inferredFromSlowTool =
            ignoreAuto && !isQuestion && SELF_APPROVING.has(s.permissionMode ?? '')
          // Fire once per parked prompt. A row that flaps waiting → ready →
          // waiting on the same outstanding call is one prompt, not two.
          if (!inferredFromSlowTool && next.firedWaitingFor !== key) {
            next.firedWaitingFor = key
            events.push(toEvent('waiting', s, group.name, s.activity, key))
          }
        } else if (prev.status === 'waiting' || !s.pendingTool) {
          // The prompt was answered (or the turn moved on) — re-arm.
          next.firedWaitingFor = undefined
        }

        // --- turn finished -----------------------------------------------
        // Prefer the transcript's own turn marker: it is written exactly once
        // per turn, whereas the registry goes idle between tool calls *within*
        // a turn and would fire several times.
        if (next.turnCount > prev.turnCount) {
          events.push(toEvent('finished', s, group.name, s.summary ?? s.activity))
        } else if (
          // Only for a session that has never written a turn marker — a Claude
          // build that predates them. Once a row has produced one marker we
          // trust the markers and never take this branch, so no turn is
          // announced twice. The status edge alone isn't enough: we also need
          // the guard that the turn actually stopped rather than parked
          // mid-tool.
          !next.usesTurnMarker &&
          prev.status === 'working' &&
          s.status === 'ready' &&
          // A staleness downgrade is a latch clearing, not a turn ending.
          !snap.staleDowngraded.has(s.id) &&
          s.stopReason !== 'tool_use'
        ) {
          events.push(toEvent('finished', s, group.name, s.summary ?? s.activity))
        }

        // --- error --------------------------------------------------------
        // Rising edge only. `errored` reflects the last assistant turn and
        // clears itself on the next good one, so this can't repeat in place.
        if (s.status === 'error' && prev.status !== 'error') {
          events.push(toEvent('error', s, group.name, s.activity))
        }

        this.prev.set(s.id, next)
      }
    }

    // Drop sessions that vanished (folder closed, transcript deleted) so the map
    // doesn't grow for the life of the extension host.
    for (const id of this.prev.keys()) {
      if (!seen.has(id)) {
        this.prev.delete(id)
      }
    }

    this.primed = true
    return events
  }
}

function toEvent(
  kind: SessionEventKind,
  s: SessionItem,
  folder: string,
  detail?: string,
  key?: string,
): SessionEvent {
  return {
    kind,
    id: s.id,
    liveId: s.liveId,
    title: s.customName || s.title || 'Claude session',
    folder,
    detail,
    key,
  }
}
