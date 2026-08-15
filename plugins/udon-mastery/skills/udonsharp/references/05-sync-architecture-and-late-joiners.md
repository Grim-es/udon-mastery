# 05 — Sync architecture & late joiners

Read §1 before designing anything networked; most sync bugs are a mechanism
chosen for the wrong retention semantics.

---

## Contents

- [1. Choose the mechanism by *retention semantics*, not by convenience](#1-choose-the-mechanism-by-retention-semantics-not-by-convenience)
- [2. Retained state is a server-side cache, and it needs a coherency protocol](#2-retained-state-is-a-server-side-cache-and-it-needs-a-coherency-protocol)
- [3. Manual sync as a protocol](#3-manual-sync-as-a-protocol)
- [4. Ownership](#4-ownership)
- [5. Idempotency, counters and epochs](#5-idempotency-counters-and-epochs)
- [6. Late joiners](#6-late-joiners)
- [7. Bandwidth](#7-bandwidth)
- [8. Presentation, smoothing and clocks](#8-presentation-smoothing-and-clocks)
- [9. Sync-mode mechanics worth remembering](#9-sync-mode-mechanics-worth-remembering)

---

## 1. Choose the mechanism by *retention semantics*, not by convenience

| | `[UdonSynced]` | `[NetworkCallable]` event |
|---|---|---|
| retention | **retained**: replayed to every future joiner | **transient**: seen only by who is present |
| arguments | none (it is state) | **typed, including arrays** |
| ownership | required, plus `RequestSerialization` on the owner | none: anyone may send |
| ordering/loss | best-effort, rate-limited, can fail | rate-limited (default **5/s**, range 1–100); **overflow queues, adding latency** |
| correct for | the **snapshot** | the **deltas** |

**The diagnostic:** if you are building a ring buffer with three cursors, an in-use latch, `IsClogged`
polling and tail-advance-on-ack over a `[UdonSynced] float[]`, you have made a retained variable imitate a
stream. Roughly 80 lines of that protocol exist only to paper over the mismatch. Split it instead:

- deltas go out as `[NetworkCallable(maxEventsPerSecond: 3)] void Handle(float[] positions)`;
- the one-shot late-join snapshot lives in `[UdonSynced]` on a **separate behaviour**.

The protocol disappears, and because the delta path needs no owner, **anyone can act simultaneously**.

Make the sender act without waiting for a round trip by sending to `NetworkEventTarget.All` rather than
`Others`: the sender then runs the *identical* handler body instead of a hand-written local branch that
can drift from it. See [06 §1](06-network-event-dispatch.md#1-what-the-platform-gives-you).
`[NetworkCallable]` methods may not be generic/static/virtual, may not have a return type, are limited to
8 parameters, and may not use `ref`/`out`/`params`/default values: full validation list at
`CompilationContext.cs:435-478` (**Worlds SDK 3.10.4**). Total parameter size across one event is capped at
**16 KB**.

Where you *do* keep synced variables, treat **the synced variable, not the byte, as the unit of cost**,
though the per-variable serializer overhead this rests on is **unmeasured**, and it is the weakest
load-bearing assumption in this file.

---

## 2. Retained state is a server-side cache, and it needs a coherency protocol

Two halves of one idea.

**Exploit it.** VRChat replays the last serialized state of a Manual-sync behaviour to every future joiner.
So even when there is nothing to send, assign `syncPositions = new float[0]`, set `serializationType =
Full` and serialise **once**: that converts an O(players) event stream into O(1) traffic. Every future
joiner receives it automatically and can set its own `_lateSyncComplete`: no per-join event, and once the
server holds the signal it never needs resending.

**Guard against it.** The same retention means a snapshot published before an edit is now **stale**, and
would be applied verbatim by the next joiner: resurrecting erased state. So make `LateSyncType.Ignore = 0`
a **tombstone**: any mutation clears the published snapshot and serialises once purely to overwrite the
server copy, then sets `_isDirty`; rebuild the real snapshot **lazily**, only when a joiner actually
appears. `Ignore` (tombstone) / `AddRange` (payload) / `_isDirty` is a write-invalidate cache protocol.
Model your synced variable that way.

---

## 3. Manual sync as a protocol

**Reliable delivery with no acknowledgement traffic**:

- a **monotonic revision + server-time pair** in the payload;
- **retry on `!result.success`** in `OnPostSerialization`;
- **drop stale** on receive by comparing revisions;
- hook **`_DeserializationOutOfDate`**; the decision rule is to *forward* it to your normal handler when the payload is idempotent, and no-op only when applying old state could regress something;
- **`Networking.IsClogged`** as back-pressure, with two *distinct* bools: one to coalesce, one to keep exactly one retry outstanding.

**Advance the tail only on ack.** A ring buffer with a write head, a confirmed tail and a pending count;
the tail moves only in `OnPostSerialization` when `result.success`. The critical piece is the
`_syncVariableInUse` latch: **a second `RequestSerialization` before `OnPostSerialization` silently
replaces the payload**, losing everything in flight. On overflow, *drop* rather than corrupt ordering.

**Write `Owner = local; RequestSerialization();` as a *prologue*.** `RequestSerialization` means "mark
dirty", not "send now", so putting it first is robust against early returns later in the method.

**Out-of-order rejection needs rollback.** A 4-bit sequence plus a half-window compare tells you a packet is
old, but **Udon has already overwritten your fields** by the time `OnDeserialization` runs, so rejecting
means restoring from a shadow copy.

**`[FieldChangeCallback]` fires on every deserialization, not only on change.** One setter can be the single
local+remote code path, with owner-only work fenced by `IsOwner()`. But for several fields that must
change *together*, prefer **shadow `syncX` mirrors and a two-phase detect/adopt/react**: per-field
callbacks give you neither atomicity nor ordering. The "restore the old value inside the setter so the
change guard passes on the real assignment" idiom belongs to that pattern.

**`OnPreSerialization`/`OnDeserialization` are codec hooks.** `[UdonSynced] byte _flags` is the wire format,
plain bools are the model, and packing happens at one choke point that cannot be forgotten. The same hook
projects un-syncable reference types: a `Gradient` becomes a shadow `[UdonSynced] Color[]`, and you must
**reassign** `gradient.colorKeys = colors;`, because the property returns a copy. Syncing only the colours
and never the key *times* halves the payload and enforces the designer's authored curve on every client.

---

## 4. Ownership

**Derive ownership; do not negotiate it.**

- **Orphan detection as a derivation**: `orphan = (synced held) AND NOT (locally held)`. A *snatch* emits a semantically different event, so message order stops mattering.
- **Asymmetric backoff**: "I took it" transmits immediately; "it fell to me" waits ≥0.2 s plus jitter. Race-free handoff with no handshake.
- **Deterministic handoff on collision**: faster object wins, with an asymmetric `<` so a tie gives it to *nobody*.
- **Pull, don't push, an attachment handoff**: the packet names the intended owner and exactly one client self-selects. A local-only "ownership lie" then works as client-side prediction.
- **Close the gap VRChat leaves**: it moves ownership on request, but the new owner has not published yet. Stamp `currentOwner` into the payload and compare.
- **Put acquisition and the mutation it enables in separate invocations**: `takeOwnership()` returning bool, used as the branch condition.
- **`OnOwnershipRequest` is the actual security boundary** for synced authorization data: it is the only hook computed by a *non-attacker's* client. Include the `requestingPlayer == requestedOwner` clause; most implementations omit it.
- **A per-player `VRCPlayerObject` sender designs contention out of existence**, and makes sender identity unforgeable, because it *is* `GetOwner`.
- **Ownership of a helper GameObject as a synced one-slot register** ("who requested this").
- **A generation counter incremented by 2 when you are not the owner** wins the race with an outgoing owner by arithmetic alone.
- **Sync mode is resolved per GameObject.** The safe assumption is that a `BehaviourSyncMode.None` behaviour may not share a GameObject with a `Manual`-synced one, and the standard tax is splitting every local-only helper onto its own object. **Contested and unverified**: tooling exists that patches out UdonSharp's enforcement on the grounds that it is a convention rather than a runtime requirement. If that is right the tax disappears; test it before relying on either answer.

---

## 5. Idempotency, counters and epochs

**Counters, not booleans, for events.** A bool cannot express "it happened twice", and a bool is not
replay-safe. Express a teleport as a **wrapping counter difference**: idempotent, replay-safe, and a late
joiner snaps to spawn *by construction*. A synced `int` hash works as a generation token that needs no
counter.

**Sync the epoch, not the value.** One `_videoStartNetworkTime`; every client derives position; seeking
means moving the epoch. Steady-state traffic is zero and a late joiner is correct on first deserialize.

**Broadcast a verb; each client self-selects.** Addressing one player is broadcast plus a target id in the
payload. Use `NetworkEventTarget.All` rather than `Others` so the correction is idempotent on the sender
too, which is what makes it possible to ship a large system with **zero** `[UdonSynced]` fields.

**Calling your own `OnDeserialization()` manually** turns an unreliable push channel into a reliable pull
one, with the design obligation that it be idempotent and never read "previous" state. The symmetric
trick: `RequestSerialization(); OnDeserialization();` makes the owner a receiver of its own broadcast.

**Eventual consistency by intent re-assertion** is the reverse trade from reliable sync: local intent is
authoritative, the synced array is a cache to be repaired, and every disagreement schedules an idempotent
retry. Here the *payload* is unreliable and the *intent* is durable.

**Self-healing repair at zero traffic**: replay the message you already have, on a jittered delay scaled by
measured latency, cancelled if newer data arrived, and repair on a fixed *global* budget (one message
per 50 ms world-wide) so it converges by time rather than by rate.

---

## 6. Late joiners

Four answers, in increasing order of cost:

1. **Bake it.** Run the marshaller *in the editor* and put the payload in the scene. Zero packets. A zero-skipping counter makes `== 0` a permanent never-synced predicate.
2. **Derive it.** Broadcast a **delta from the prefab default** with `NetworkEventTarget.All`, so the correction is idempotent everywhere.
3. **Let retention do it.** One `Full` packet, possibly empty (§2).
4. **Read it back off the GPU.** When state lives only in VRAM, `VRCAsyncGPUReadback` is the only source: clamp the payload keeping the **newest tail**, and ship the feature off by default with a bandwidth warning. See [09](09-udon-gpu-bridges.md).

Three rules:

- **Synced fields are NOT populated in `Start()`.** `Start()` may only set "I am waiting" flags; all state application belongs in `OnDeserialization`, with a one-shot snap branch for the first arrival.
- **There is no "initial sync received" callback**, so add a start-up **grace window** (`StartTime + 5 < Time.time`) or a late joiner's own UI initialisation clobbers authoritative state.
- **Serialization callbacks never fire when you are alone in the instance.** The single most common "works with a friend, does nothing solo" bug.

**Stagger the responses.** Randomised self-scheduling is the substitute for the static coordinator Udon
forbids. The sharp version makes **the width of the random window proportional to payload size**, so the
expected inter-arrival gap scales with the cost of each transmission. Fixed staggered resends (5 s, then
7 s) are the crude version and still beat a thundering herd.

---

## 7. Bandwidth

**Measure it.** `SerializationResult.byteCount` is the one-line instrument that makes every sync-byte
decision measurable.

**Assert it at `Start()`.** Udon has no `Debug.Assert`, no exceptions and no editor validation that can see
runtime rates, so derive the number where the relationship is knowable and log loudly:

```csharp
int lateSyncMaxBytes = lateSyncMaxCount * 4 * 3;
// https://creators.vrchat.com/worlds/udon/networking/network-details/#bandwidth-limits
const int maxAllowedBytes = 280496;             // roughly
if (lateSyncMaxBytes > maxAllowedBytes) Log("lateSyncMaxBytes > maxAllowedBytes");
```

Enforce it **twice**, with different roles: a loud developer-facing assertion at startup, and a silent
runtime clamp that keeps the *newest* data. Derive `bytesPerSecond` from your tick rate the same way and
check it against 11 000.

**Then reduce it.** The reference shape is unsynced state on the engine plus a **swappable synced
*marshaller* sibling**: several subclasses of one abstract base, chosen at edit time, taking a payload
from 65 bytes / 14 variables down to 36 bytes / 3 with the protocol written once on the base. Techniques
inside it:

- two `short`s inside one `float` (1/90 fixed point, explicit sign extension);
- a quaternion as angle-axis × angle = three floats;
- a whole flag word smuggled into `vel_flags.z`;
- one `sbyte` as a **discriminated union**: negatives are built-ins, −4−k is bone k, 0..127 is an index into `customStates[]`; the array index *is* the vtable slot;
- quantise a heading to a `short` (2 bytes vs 16), using `Convert.ToInt16` because it **rounds** where a cast truncates;
- `sbyte[2]` quantised position (±1.27 m at 1 cm) with an `OnPreSerialization` staging copy, and an **explicit clamp**, because a narrowing cast *wraps* rather than saturating;
- **two synced states packed into one byte by numeric offset** so they are one atomic value: no callback-ordering question and no `if (transmitting)` anywhere;
- **orthogonal bitfields in one synced `int`**, so atomicity is structural;
- **a commented-out `[UdonSynced]`** left in place as a bandwidth feature flag.

**The un-measured premise**: all of this assumes per-variable overhead dominates per-byte. Nobody has
measured it. And NaN/denormal survival through VRChat's serializer (which the bit-packing depends on) is
the highest-risk assumption in the design.

---

## 8. Presentation, smoothing and clocks

- **A local clock anchored to server time**: sample at 1 Hz, integrate `Time.deltaTime`, correct at 1/20 strength, and **keep the sub-millisecond remainder in an accumulator**. Re-anchor exactly on frame hitches (`deltaTime > .099f`). `SmoothDamp` used as a **low-pass filter on a clock**, not as easing, is the same idea where `Networking.SimulationTime` misbehaves for VR owners.
- **Latency compensation by round-tripping the server clock inside the payload**, with asymmetric play/pause drift thresholds.
- **Transform sync as a parameterised RPC with zero `[UdonSynced]` fields**: a sender-stamped server time gives both sample age and the true inter-update interval, and makes the message idempotent by timestamp.
- **Put the discontinuity flag *inside* the playout buffer.** A synced bool cleared in `OnPostSerialization` is an edge-triggered event strictly ordered with the state it describes; store it per-sample and express "snap" as `t = 1` so it stays on the same lerp code path.
- **Infer idle mode; don't flag it.** The sender adapts its rate and the receiver infers the mode from inter-arrival timing, so nothing extra goes on the wire; then kill all per-frame work and make the rigidbody kinematic.
- **GPU-side timestamps with CPU-side rate *prediction***: each point's alpha channel stores a reveal timestamp and the shader simply doesn't draw the future. Udon does ~4 float ops per received batch and never touches the point again. `Clamp(elapsed, rate*0.5, rate*2)` is the entire jitter defence, and the running offset must be a **phase accumulator, not a smoothing filter**; the accumulator is what guarantees monotonic reveal order when the prediction is wrong.
- **Make physics authority a hard switch**: a full property profile per ownership state, re-seed every extrapolation accumulator on loss, and never read `rigidbody.position` for the send.
- **Async callbacks need their own delta time**: `Time.deltaTime` inside `OnDeserialization` or a readback callback describes the rendering frame, not the interval since your callback last landed.

---

## 9. Sync-mode mechanics worth remembering

- Synced **array** fields require `Manual`; `Continuous` rejects them.
- **Always initialise a synced array, even to `new T[0]`.** If *any* synced array on a behaviour is left null, **the whole behaviour stops syncing**, silently and including its scalar fields. One uninitialised array kills every other synced variable next to it.
- **`Continuous` is capped at roughly 200 bytes per serialization, and overflow *fails the send*** with an error in the log. `Manual` behaves better under the same pressure: it caches the event and retries. Anything near that size belongs on `Manual`.
- `BehaviourSyncMode.None` disables `SendCustomNetworkEvent` but **not** local `SendCustomEvent`. Use `NoVariableSync` for network events without synced variables.
- `RequestSerialization()` only works on the **owner** of a `Manual`-sync behaviour.
- A `RequestSerialization` on a fixed cadence is "Continuous with a rate knob and an off switch".
- **Sync mode can be build-time data**: ship the class with no `[UdonBehaviourSyncMode]` and write `backingUdonBehaviour.SyncMethod` at build, or strip a whole subtree to `None` at build. Sync mode becomes a **deployment** decision rather than a type decision.
- **`[System.NonSerialized, UdonSynced]`** gives a synced variable whose initial value comes from the C# initialiser and never from the scene: deliberately the opposite of the transform tiers.
- **Ownership transfer changes nothing about a disabled behaviour**: disabled behaviours never initialise and silently miss sync, so toggle pooled objects active-then-back at `Start`.
