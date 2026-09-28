# Bounded transcript delivery

Large image-heavy sessions previously exceeded the relay client's 32 MiB
reassembly cap. The sender split the encrypted history into WebSocket-sized
chunks, but the receiver still needed the entire sealed history at once and
silently discarded it. Cache recovery resent the same oversized response.

The node now projects embedded images in client-visible history, live events,
and replay into content-addressed attachment references. Both direct content
blocks and nested tool results are covered. Native runtime transcripts and
persisted base messages retain their original data for resume. Existing
sessions are projected lazily; references use durable event-log records so
attachment GC retains their blobs. A storage/encoding failure leaves a visible
image-unavailable note rather than silently dropping the whole conversation.

## Large-response protocol

Relay events of at most 4 MiB of UTF-8 JSON keep the existing wire format. Larger
events use an immutable snapshot and authenticated pull requests:

1. The sender seals the serialized event with a fresh AES-256-GCM key and retains
   the ciphertext. It sends a small `session.notice`
   with `code: "transfer_required"`, the original session/request identity, and
   `transfer: { id, bytes, key, iv, pageBytes }`.
2. The receiver sends `transfer.read` with a random request ID, transfer ID, and
   byte offset. Only one page is in flight. The node answers `transfer.part`
   with the same identifiers and base64 bytes. Each page is independently
   encrypted and fits well below the existing relay reassembly cap.
3. Missing pages retry twice. Offsets and lengths are checked and the completed
   response is authenticated and decrypted before decoding JSON.
4. The receiver emits the original event only when complete. Later events wait
   behind it, so a history cursor/sequence baseline cannot advance from partial
   history, and later live output cannot be overwritten by that snapshot.

This mechanism handles history, attachments, and large individual messages
without splitting the history reducer's atomic commit. It also covers the CLI
relay bridge and node-to-node clients. Direct HTTP/WebSocket delivery retains
its existing response format and uses the same image projection.

## Bounds and recovery

- Page: 384 KiB decoded bytes (512 KiB base64, before encryption).
- One logical response: 64 MiB ciphertext, including its 16-byte authentication
  tag. This is an explicit resource limit, not a promise to load arbitrarily
  large sessions in memory.
- Sender snapshots: at most 128 MiB and 16 entries, with two-minute idle expiry
  and a ten-minute absolute lifetime. Successful page reads renew the idle lease.
  Active snapshots are not evicted to make room for new ones. Expiry and capacity return explicit errors.
- Client: one active response, plus at most 8 MiB / 4,096 queued later events.
- Page timeout: ten seconds, two retries. A retry resumes at the missing byte
  offset. Reconnect drops partial state and the existing history/replay path
  obtains a fresh snapshot.
- Encrypted-frame reassembly: 32 MiB aggregate buffering, at most 16 groups,
  thirty-second expiry, consistent chunk counts, and explicit rejection.
  Completed/rejected group tombstones suppress late duplicate chunks.

The relay stays blind to content and protocol semantics. Transfer commands are
processed only after room-key authentication and replay checks. No new HTTP
endpoint or public blob URL is added. Random transfer IDs are carried only
inside encrypted frames, together with the per-transfer key and IV. The GCM tag
authenticates the complete snapshot, including page order and content. Node
transfer data is held in memory and reclaimed;
it is not written to another transcript file.

Transfer errors preserve cached transcript text and do not change the agent's
execution status. Interrupted/inconsistent transfers invalidate the stream and
reconnect for history recovery. Limits above the transfer ceiling report an
error instead of repeatedly trying to reassemble an impossible payload.

## Compatibility and scope

Small responses remain readable by older clients. Older clients receiving a
large-response offer display its update notice; deploy the updated web/CLI
clients with the node. New clients continue to accept old nodes' single-event
responses, but an old node cannot serve an oversized response: receiver errors
now make that failure visible. Users must update that node for recovery.

This change uses transport pages and a complete snapshot commit. It does not
add newest-first history windows or infinite-scroll pagination; those would
require separate partial-history/cache semantics. The explicit 64 MiB ceiling
remains until a windowed transcript store is implemented. A permitted 25 MiB
attachment fits this transfer protocol despite the nested base64 expansion.

Regression coverage exercises the former size limit, a maximum-size attachment,
UTF-8 boundaries, lost-page retry, corrupt/expired responses, reconnect cleanup,
live-event ordering, both crypto/chunking stacks, and image retention/rendering.
Synthetic fixtures keep private transcripts and images out of the repository.
