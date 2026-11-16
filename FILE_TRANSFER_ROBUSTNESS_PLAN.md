# File Transfer Robustness Plan

Goal: make Direct Drop's P2P file transfer reliable across browsers, networks,
file sizes and failure conditions. Milestones are implemented one at a time;
each ends in a working, testable state.

Status legend: ⬜ not started · 🟡 in progress · ✅ done

---

## ✅ Milestone 1 — Reliable transfer protocol (acks, backpressure, validation)

Problems fixed:
- Receiver never set `binaryType`; Firefox delivers chunks as `Blob`, which the
  receiver silently dropped (`instanceof ArrayBuffer` check).
- Sender marked a file/transfer "complete" when data was merely *queued* in the
  channel buffer, not when the receiver actually had it.
- A `setTimeout(100)` was used instead of a real handshake after metadata.
- Backpressure used a 10 ms polling loop instead of `bufferedamountlow`.
- No validation: received byte count was never checked against the expected
  size; out-of-order / unknown messages were not rejected.
- Progress `setState` fired on every 64 KB chunk (thousands of re-renders).
- Send button was disabled exactly when the channel *was* ready (inverted).

Deliverables:
- `client/src/webrtc/protocol.js` — protocol version, message types, chunk
  size / buffer thresholds, `encode/parse` with validation.
- Handshake: `batch-metadata` → receiver `batch-ready` (or `batch-reject`).
- Per-file ack: `file-complete` → receiver verifies size → `file-ack`
  (`ok: true|false`). Sender only marks a file done after a positive ack.
- `transfer-complete` → receiver `transfer-ack`; sender shows "complete" only then.
- Event-driven backpressure via `bufferedamountlow`.
- Waits reject if the channel closes, so the sender never hangs forever.
- Progress throttled to whole-percent changes.

## ✅ Milestone 2 — Failure handling & cancellation

- Detect peer loss mid-transfer: `pc.connectionState` / `iceConnectionState`
  `failed`/`disconnected`, data channel `close`, socket `peer-disconnected`.
- Show clear error states on both sides (no silent hangs); reset hooks cleanly.
- Cancel button on both sides → `transfer-cancel` message; partial data discarded.
- Ack / handshake timeouts with descriptive errors.
- Fix socket listener cleanup (`socket.off(event)` without handler removes
  other listeners) and handle `peer-disconnected` in `SocketContext`.
- Allow multiple batches per session without re-connecting (state reset).

Deliverables:
- Protocol v2: every batch has a `batchId` echoed by all replies, so stale
  acks from a cancelled batch can't satisfy the next one.
- `transfer-cancel { batchId, reason, error }` in both directions; `error: true`
  marks a failure (shown as error) vs. a user cancel (shown as cancelled).
- `TransferError` with codes `cancelled | peer-cancelled | peer-error | timeout | disconnected`.
- Sender: `AbortSignal` support, handshake (15 s) / ack (30 s) / buffer-drain
  (30 s) timeouts; on any local failure it sends `transfer-cancel`.
- Receiver: `cancel()` / `abort()` API, 30 s idle watchdog, drops partial file.
- `webrtc/connectionMonitor.js`: 20 s connect timeout, 5 s grace on `disconnected`.
- Hooks build one peer session per connection attempt; sender can `reconnect()`
  (receiver accepts any new offer), receiver rejoin triggers a fresh connection.
- `SocketContext`: socket kept in state, handles `peer-disconnected { roomClosed }`,
  `resetRoom` emits `leave-room`.
- Server: shared `leaveRoom` for `disconnect` and `leave-room`; closing the room
  when the sender leaves also removes the receiver from it.

## 🟡 Milestone 3 — Large files without running out of memory

- Receiver streams chunks to disk instead of holding the whole file in RAM:
  1. File System Access API where available,
  2. OPFS (`navigator.storage.getDirectory`) + writable stream,
  3. In-memory `Blob` fallback with a size warning.
- Sender reads slices lazily (already does) and keeps a bounded buffer.
- Test with ≥ 2 GB file. ⬜ (needs a manual two-browser run)

Deliverables:
- `webrtc/storage.js`: backend chosen per batch — folder picked via
  `showDirectoryPicker` (one click up front; `showSaveFilePicker` would need a
  click per file and can't be triggered by an incoming batch) → OPFS if the
  storage quota covers the batch → memory (warning above 500 MB).
  OPFS files are disk-backed `File`s handed to the normal download flow;
  leftovers older than 30 min are swept on load and before each batch.
- Folder mode never overwrites: `name (1).ext`; sender file names are sanitised.
- Protocol v3 flow control: receiver sends `chunk-ack` every 1 MB *persisted*;
  sender keeps ≤ 8 MB un-acked per file, so a slow disk can't pile chunks up
  in receiver memory (verified: backlog capped at 8 MB with a slow fake sink).
- Partial files are deleted on cancel / error / disconnect; write failures
  (incl. `QuotaExceededError`) abort the batch with a clear message.
- Receiver UI: "Choose folder / Use downloads" control, per-batch storage
  warning, "Saved as …" per file.

## ⬜ Milestone 4 — Integrity verification

- Sender computes SHA-256 per file (incremental hashing, e.g. `hash-wasm`,
  since `crypto.subtle.digest` is not streaming) and sends it in `file-complete`.
- Receiver hashes as it receives and compares; mismatch → `file-ack ok:false`.
- UI shows "verified" badge / failure per file.

## ✅ Milestone 5 — Resume after interruption

- Track received offset per file on the receiver.
- On reconnect (new peer connection in the same room), receiver
  sends `resume { fileIndex, offset }`; sender continues from that offset.
  (ICE restart is part of Milestone 6.)
- Requires Milestone 3 storage so partial data survives.

Deliverables:
- Protocol v4: after a reconnect the sender sends `batch-resume` (same payload
  as `batch-metadata`); receiver replies `resume { fileIndex, offset }` with the
  bytes it has *persisted*, or `{ done: true }` if only the final ack was lost,
  or `batch-reject` / `transfer-cancel` if it no longer has / cancelled the batch.
  `file-start { offset }` continues the open partial file in place.
- Receiver: one protocol receiver per room that outlives peer connections;
  `suspend()` on connection loss keeps the batch and partial file for
  `RESUME_TIMEOUT_MS` (2 min). File list is re-checked on resume.
- Sender: `createBatchSender()` is re-runnable; auto-reconnect with backoff
  (1/2/4/8 s), then a manual "Reconnect & resume". Cancelling while offline is
  delivered to the receiver on the next connection.
- Signaling survives network drops (otherwise the room – and the batch – was
  thrown away on any socket disconnect):
  - Server: Socket.IO connection state recovery (2 min). A dropped member keeps
    its room slot for the window; the peer gets `peer-offline` /
    `peer-reconnected`; `room-expired` if it recovers too late. A new receiver
    may take over an *offline* receiver's slot (page reload). Intentional
    disconnects (`pagehide`, leave) still free the slot immediately.
  - Server sends `room-keepalive` to every room every 30 s – recovery needs
    the client's last event id to be within the window, and a long transfer
    produces no signaling otherwise (verified: idle 70 s → recovery fails
    without it, succeeds with it).
  - Client keeps `roomId` through a recoverable socket drop and retries forever.
  - Offers / answers / ICE candidates carry a `sid` (connection attempt id) so
    stale or replayed signaling is ignored.
  - Sender pauses retries (`waitingForPeer`) while either socket is offline and
    reconnects as soon as both are back, without using up retry attempts.
- ⬜ Manual two-device test: toggle Wi-Fi / airplane mode mid-transfer on the
  phone, confirm it resumes from the last byte.

## ⬜ Milestone 6 — Connectivity (NAT traversal)

- Configurable ICE servers via env (`VITE_ICE_SERVERS` JSON), TURN support.
- ICE restart on `failed` before giving up.
- Show connection type (direct / relayed) in UI.

## ⬜ Milestone 7 — Signaling server hardening

- Validate every incoming payload; guard `callback` being undefined.
- Only relay signaling between the two members of a room.
- Rate-limit `join-room` attempts per socket/IP (4-digit codes are brute-forceable)
  and consider longer codes.
- Room TTL / expiry; clean up receiver slot correctly; remove debug logs.

## ⬜ Milestone 8 — Automated tests

- Unit tests (Vitest) for `protocol.js`, sender and receiver state machines
  using a fake data channel (drops, reordering, early close).
- E2E test (Playwright) with two browser contexts sending real files,
  including a Firefox ↔ Chromium run.
