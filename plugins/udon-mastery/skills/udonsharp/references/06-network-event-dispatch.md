# 06 — Network event dispatch

Getting a *call with arguments* across the network.

---

## Contents

- [1. What the platform gives you](#1-what-the-platform-gives-you)
- [2. Rolling your own: the primitive](#2-rolling-your-own-the-primitive)
- [3. Wire format, if you are writing one](#3-wire-format-if-you-are-writing-one)
- [4. Addressing](#4-addressing)
- [5. Rate, coalescing and replay](#5-rate-coalescing-and-replay)
- [6. Timeline shapes](#6-timeline-shapes)
- [7. The two-instruction calling convention, and when to prefer it](#7-the-two-instruction-calling-convention-and-when-to-prefer-it)
- [8. The trust boundary](#8-the-trust-boundary)

---

## 1. What the platform gives you

| | arguments | retained | target selection |
|---|---|---|---|
| `SendCustomEvent(string)` | none | n/a | local only |
| `SendCustomNetworkEvent(target, string)` | none | no | `All` / `Others` / `Owner` |
| `[NetworkCallable]` + `NetworkCalling.SendCustomNetworkEvent(receiver, target, name, args…)` | **typed, ≤8, incl. arrays** | no | as above |
| `[UdonSynced]` + `RequestSerialization` | it *is* the argument | **yes** | broadcast to all + future joiners |

`[NetworkCallable]` is the modern answer and should be your default for deltas — see
[05 §1](05-sync-architecture-and-late-joiners.md#1-choose-the-mechanism-by-retention-semantics-not-by-convenience).
Its validation list (`CompilationContext.cs:435-478`, **Worlds SDK 3.10.4**): public, non-generic,
non-extern, non-operator, non-virtual/abstract/override/vararg/async/static/sealed, no explicit interface
implementation, no return type, ≤8 parameters, **no `ref`/`out`/`params`/default values**, and no
overloading of any kind.

Two consequences of that last clause:

- **Make the flag bit the method name.** Two `[NetworkCallable]` entry points funnelling into one private body sidesteps the ban on overloads *and* on default arguments. Choose the split so the distinction carries information, e.g. the non-teleport variant passing `WasOwner`, so "no extrapolation history" and "I used to own this" become the same bit.
- **Send to `NetworkEventTarget.All`, not `Others`**, when the sender must also act. The sender then runs the *identical* handler body instead of a hand-written local branch that can drift from it, and the handler becomes idempotent on the sender for free.

**The target method must be `public`.** Both `SendCustomEvent` and `SendCustomNetworkEvent` resolve by name against the exported symbol table; a `private` or `internal` target is a **silent no-op**, not an error.

**`_`-prefixed public methods are not network-callable** — VRChat refuses to dispatch to them. Apply it even
to self-scheduled pumps, and record the intent where a reader will see it (§8).

---

## 2. Rolling your own: the primitive

On older SDKs, or when you need more than 8 arguments, or arbitrary types:

> **`SetProgramVariable` can write a method's *parameter slots*, not just its fields.**

Everything else in such a serialiser answers "what are those slots called?" — recoverable at build time in
three places: `CompilationContext.BuildMethodLayout`, `MethodSymbol.Emit`, or a Roslyn syntax-tree rewrite
before U# sees the code.

Two metadata strategies, and the trade is real. **Choose by whether you must describe programs you did not
compile.**

**A. Scene side-table.** Harmony-scrape `BuildMethodLayout` into JSON of export and parameter symbol names,
and bake it into a scene string at `[PostProcessScene(-100)]`. One artefact, one place to look, works only
for programs in *your* build.

**B. Per-program `__refl_*` symbols.** A Harmony prefix on `MethodSymbol.Emit` calls `CreateReflectionValue`
to add `__refl_argnames_<export>`, `__refl_argtypes_<export>`, `__refl_returnname_<export>` and
`__refl_returntype_<export>` heap symbols. The result is **self-describing behaviours**: the metadata
travels with the program, so it works on *third-party* programs. It also gives you **return values out of
`SendCustomEvent`**: read `__refl_returnname_<export>` immediately after the call, and only immediately
after.

Both depend on U#'s internal naming conventions (`__N_`, `__refl_*`, `ExportMethodName`). **Pin your SDK
version** if you build on either.

Related tools in the same space:

- **Runtime overload resolution** by probing the `__N_Name` mangling, with `GetProgramVariableType(x) == null` as the existence probe.
- **Roslyn syntax-tree injection**: postfix `LoadSyntaxTreesAndCreateModules`, parse trampoline members from a source string, `AddMembers` to every `UdonSharpBehaviour` class. Keep `ParseOptions` and `FilePath` when swapping a tree so user diagnostics still resolve.

---

## 3. Wire format, if you are writing one

- **Method ID = index into a *sorted* shared key list.** The canonical sort is load-bearing: both ends must derive the same ordering from the same data. Varint-encode it and it is one byte under 128 methods.
- **One byte carries type + sign + length.** Enum bands 10 apart (`Int32V = 80`, `Int32VN = 90`), with the tag being *band + significant byte count*. Zero costs one byte total.
- **Two varints by signedness**: a UTF-8-shaped prefix (a branch chain, no loop) for unsigned; zigzag LEB128 for signed. Thread the cursor by return value rather than by a field.
- **IEEE-754 float ↔ bits by multiply-loop normalisation**, where `BitConverter` is unavailable, with NaN and Inf pre-checked, or the loop hangs.
- **Hand-rolled UTF-8**, sending both char count and byte count. `string.Concat(string[])` is the `StringBuilder` substitute on the hot path.
- **Length-prefixed frames**, so a non-target can skip a message without parsing it. Build them with `InsertRange(0, …)` at the end, because a `DataList` has no backpatch.
- **One `uint` multiplexes mode, channel and player-target by disjoint numeric ranges**, with out-of-range enum values as "none" sentinels.
- **Exact preallocation and variable-length encoding are mutually exclusive** unless you encode twice. Two passes buy an exactly-sized buffer; the alternative is `DataList` accumulation and a copy.

> **If you are vendoring miner28's NetworkedEventCaller, do not copy its shared helpers verbatim.**
> `ReadDouble` ignores its `startIndex`, and one `0xFE` switch arm is unreachable. The design is worth
> studying; those two functions need fixing before use.

---

## 4. Addressing

**Broadcast plus self-selection** is the near-universal answer to "send this to one player":

- put the target id in the payload and let every client decide;
- **name the intended owner in the packet and let exactly one client self-select**, a whole attachment-handoff protocol in one rule;
- `NetworkEventTarget.All` rather than `Others` makes a correction idempotent on the sender too, which is what lets a large system ship zero synced variables;
- **the sender executes locally through the same dispatch path**, skipping the round trip, and thereby sees *unquantised* values the remotes never see. That is a real behavioural difference; test with two clients before assuming parity.

**Sender identity is unforgeable when the sender is a `VRCPlayerObject`**, since it *is* `GetOwner`, which
designs both spoofing and ownership contention out of the problem.

---

## 5. Rate, coalescing and replay

- **Coalescing window + self-rescheduling drain.** A 0.33 s window, a drain that re-checks and re-schedules, and a monotonic sequence number. One timestamp plus one delayed event is enough to get both leading- and trailing-edge debounce.
- **Three stacked replay defences**: `isFromStorage`, an empty-buffer check, and the sequence number.
- **A networking pause with a replayable backlog**, draining ≤25 messages per frame, with a defensive `Array.Copy` off the live synced field before touching it.
- **`[NetworkCallable]` rate limiting queues events rather than dropping them.** *"if too many events are sent in short succession, they will be queued until the rate limit allows them to be sent."* So overflow costs **latency and ordering lag**, not delivery: a burst arrives late, and a sender that keeps overproducing grows an unbounded backlog. Rate-limit at the source anyway (§5's coalescing window); do not rely on the ceiling to shed load.
- **Over 1 KB of parameter data is split into multiple events internally.** Nothing fails, but one logical call becomes several transmissions. Size payloads with that in mind, and do not assume atomic arrival.
- **Know the default: 5 events/second.** A bare `[NetworkCallable]` with no argument throttles at 5/s. The configurable range is **1–100**, so `maxEventsPerSecond: 3` *tightens* the limit below default; set it above your real rate or leave it alone.
- **`Networking.IsClogged`** as back-pressure, with two distinct bools: one to coalesce, one to keep exactly one retry outstanding.
- **`Networking.FindComponentInPlayerObjects` logs a line per non-matching PlayerObject, per call.** Cache its result; never call it in a loop.

---

## 6. Timeline shapes

- **Unroll the timeline; do not chain it.** Schedule every step at absolute offsets *inside one `[NetworkCallable]`*: readable, robust to a missed step, and synchronised across clients for the cost of one message.
- **Synthesise the event stream to reconcile state.** Fill the `OUT_` fields by hand and call your own handlers, which only works because the ABI's payload channel is fields, not arguments.
- **A synced delta descriptor riding the payload** (`changeMode`/`changeIndex`) lets remotes fire fine-grained events from a snapshot-only sync, a write-ahead-log op-code applied to Udon. Re-stamp the pending row on retry.
- **A negative acknowledgement with a timeout**: one flag suppresses both my default action *and* my broadcast, and expires on its own.

---

## 7. The two-instruction calling convention, and when to prefer it

Even with `[NetworkCallable]`, the *local* argument channel is still
`SetProgramVariable` + `SendCustomEvent` ([03](03-event-and-callback-architecture.md)). The cleanest
packaging is a ~20-line forwarder behaviour carrying baked strings for the field name, the method name and
one target reference, which serves **every** logical event because both names are scene data. You need it
because VRChat contact callbacks only reach behaviours on the receiver's own GameObject, so a behaviour
that wants to aggregate several receivers cannot receive their events directly and cannot subscribe.

The cost model that should decide your API shape:

> A cross-behaviour call is `SetProgramVariable`×args + `SendCustomEvent` + `GetProgramVariable`.
> **Make each crossing do as much work as possible**, and remember that a **default argument the caller
> does not pass is one fewer heap write**, so defaults are an EXTERN reduction, not merely ergonomics.

---

## 8. The trust boundary

Start here, because the rest of this section follows from it: **a client you do not control decides what to
send you.** Modified clients exist. Treat the set of remotely reachable methods as an API published to
everyone who can join the instance.

### What is reachable, and what is not

| | Reachable by a remote client? |
|---|---|
| `public void Foo()` | **Yes** — by name, via legacy `SendCustomNetworkEvent` |
| `public void _Foo()` | **No** — the receiving client refuses it |
| `[NetworkCallable] public void _Foo()` | **Yes** — the attribute overrides the underscore |
| anything on a `BehaviourSyncMode.None` behaviour | **No** — that behaviour refuses network events entirely |
| non-`public` | **No** |

The underscore rule is enforced **on the receiver**, not the sender: *"Events starting with an underscore may
not be run remotely."* That asymmetry is the whole reason it works as a defence: a hostile client can put
any string on the wire, and still cannot make a legitimate client execute a `_`-prefixed entry point.

Three things the underscore is **not**:

1. **Not access control.** It gates network invocation only. Local `SendCustomEvent`,
   `SendCustomEventDelayedSeconds`, a UI Button's `onClick` and direct calls from other behaviours all still
   reach a `_` method. It stays `public` and stays in the symbol table.
2. **Not a lock.** `[NetworkCallable]` deliberately overrides it.
3. **Not proof of authority.** A `[NetworkCallable]` handler *can* read `NetworkCalling.CallingPlayer`:
   the receiving client establishes that context before dispatch. A **legacy** `SendCustomNetworkEvent`
   handler gets no sender at all. So on the modern path you have a sender to route on, but it is set by
   the receiver from what the transport reports, not cryptographic proof: any rule of the form *"only the
   DJ may call this"* should still be re-derived from synced state the attacker does not own.

### The GameObject-wide fan-out of legacy events

A legacy network event runs the named method on **every `UdonBehaviour` on the target GameObject** whose sync
mode is not `None`, not only the behaviour you addressed. Two behaviours sharing a GameObject and a method
name are therefore both reachable through either one. Name collisions stop being a style question and become
an attack surface.

### The default to adopt

**Prefix every public method with `_` unless it is deliberately a network entry point.** That flips the
default from open to closed and leaves a short list of real endpoints a reviewer can actually audit, because
the alternative is auditing every `public` method in the world. It costs nothing: local dispatch, UI wiring
and cross-behaviour calls are unaffected.

**The one exception: never rename a built-in VRChat event.** `Interact()`, `Start()`, `OnPlayerJoined`,
`OnDeserialization`, `OnPickup` and every other engine-called entry point must keep their exact names, as the
engine dispatches them by name and an underscored copy simply never fires. The prefix rule governs methods
*you* named, nothing else.

For each endpoint that survives the prefix:

- **Validate arguments; do not trust them.** `[NetworkCallable]` parameters arrive straight off the wire. An
  out-of-range index halts the behaviour and a NaN can crash the client, and there is nothing to `catch`.
- **Re-derive authority from synced state**, never from the fact that the call arrived.
- **Make handlers idempotent**: events can arrive twice, out of order, or not at all. See §5.
- **Keep the endpoint thin**: validate, then delegate to a `_`-prefixed worker, so the reachable surface stays
  a boundary layer rather than the logic itself.

### Design notes for the surviving endpoints

- **`OnOwnershipRequest` is the only hook computed by a non-attacker's client**; for synced authorization data it is *the* boundary. Include the `requestingPlayer == requestedOwner` clause; most implementations omit it.
- **Scope a capability grant to a serialized *value* rather than to a user** (`_IsPreApprovedUrl`-style). This is a good shape that is easy to get wrong: the classic failure is a comparison that ends up testing a value against itself, which passes every time. Test it with a value that should be rejected.
- **Keep secrets out of the string table.** A display-name backdoor keyed on a *hash*, with the plaintext list destroyed at `Start`, is the shape. Caveat: `String.GetHashCode()` stability across runtimes is **unverified**; do not make it the only gate on anything that matters.
- **Layered auth needs an explicit escalate / de-escalate / escalate ordering**, plus plugin veto over a request. If the veto path walks an untyped registry, it must type-check before casting; an unchecked downcast there reopens exactly the hole the layering was meant to close.
