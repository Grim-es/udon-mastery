# 14 — World interaction, pickups, pooling & persistence

The VRChat API surface a world actually runs on. Everything here is verified against
`UdonSharpBehaviour.cs` in **Worlds SDK 3.10.4** and VRChat's published docs.

## Contents

- [1. `Interact()` — the entry point most worlds are built on](#1-interact--the-entry-point-most-worlds-are-built-on)
- [2. Player triggers and collisions](#2-player-triggers-and-collisions)
- [3. Pickups](#3-pickups)
- [4. Stations](#4-stations)
- [5. Networked instantiation: `VRCObjectPool` and `VRCObjectSync`](#5-networked-instantiation-vrcobjectpool-and-vrcobjectsync)
- [6. Master, instance owner, and who decides](#6-master-instance-owner-and-who-decides)
- [7. Persistence: `PlayerData` and PlayerObjects](#7-persistence-playerdata-and-playerobjects)

---

## 1. `Interact()` — the entry point most worlds are built on

```csharp
public override void Interact() { … }        // no parameters, ever
```

**It is purely local.** The player who interacted *is* `Networking.LocalPlayer`: there is no
`Interact(VRCPlayerApi)` overload and no sender argument. To make an interaction affect everyone, take
ownership and mutate synced state, or send a network event ([06](06-network-event-dispatch.md)).

Requirements and controls:

- The GameObject needs a **collider**. No collider, no interaction, no error.
- **`DisableInteractive`** (`bool`, get/set) turns off both the `Interact` event *and* the highlight outline. This is the correct way to disable an interaction, not `enabled = false`, which stops `Update` but leaves the object interactable.
- **`InteractionText`** (`string`, get/set) is the hover label. Set it in `Start()` rather than authoring it per-prefab-variant if it depends on state.
- Both are properties on `UdonSharpBehaviour` itself, so they are per-behaviour, not per-GameObject.

**The trap:** `Interact()` is a built-in event name. It must never be `_`-prefixed and never renamed; see
the prefix discipline in [06 §8](06-network-event-dispatch.md#8-the-trust-boundary), which governs methods
*you* name, not engine entry points.

---

## 2. Player triggers and collisions

```csharp
public override void OnPlayerTriggerEnter(VRCPlayerApi player) { }
public override void OnPlayerTriggerExit (VRCPlayerApi player) { }
public override void OnPlayerTriggerStay (VRCPlayerApi player) { }
public override void OnPlayerCollisionEnter(VRCPlayerApi player) { }
public override void OnPlayerCollisionExit (VRCPlayerApi player) { }
public override void OnPlayerCollisionStay (VRCPlayerApi player) { }
```

These **do** carry the player, unlike `Interact()`. Three rules:

- **They fire on every client for every player.** Guard with `player.isLocal` unless you genuinely want all clients reacting to all players: the commonest bug in this file's subject area is a zone effect applied N times.
- **`…Stay` is a per-frame entry point.** It is in the same cost class as `Update` ([08 §1](08-performance-patterns.md#1-the-frame-budget-is-spent-by-activation-not-by-early-out)), and declaring `_onPlayerTriggerStay` attaches the hidden proxy MonoBehaviour. Prefer Enter/Exit plus your own state.
- The collider must be a **trigger**, and its layer must actually collide with the player layers in the project's collision matrix. A silent no-op here is almost always the matrix.

**Never store `VRCPlayerApi` references**: keep `player.playerId` and re-resolve. See
[07 §1](07-player-systems-and-identity.md#1-player-tags-are-the-missing-static-storage).

---

## 3. Pickups

```csharp
public override void OnPickup() { }          // no parameters
public override void OnDrop() { }
public override void OnPickupUseDown() { }   // trigger pulled while held
public override void OnPickupUseUp() { }
```

All four are parameterless and **local to the holder**: the holder is the local player, and
`VRC_Pickup.currentPlayer` is who holds it. VRChat transfers ownership to the picker automatically, so
`Networking.IsOwner(gameObject)` is true inside `OnPickup` on the holder's client.

- **Sync the *consequence*, not the transform** where you can. A `VRCObjectSync` on the pickup already replicates position; your Udon should sync what the pickup *did*.
- `OnPickupUseDown`/`Up` are the "trigger while holding" channel and cost nothing when not held, a much cheaper input path than polling `Input.GetAxisRaw` per frame.
- These are ordinary callable methods: invoking `OnDrop()` yourself is a legitimate way to force a release ([03 §6](03-event-and-callback-architecture.md#6-reaching-entry-points-u-doesnt-expose)).

---

## 4. Stations

```csharp
public override void OnStationEntered(VRCPlayerApi player) { }
public override void OnStationExited (VRCPlayerApi player) { }
```

**Use the `VRCPlayerApi` overloads.** The old parameterless forms are `[Obsolete(..., error: true)]` in
3.10.4: they are a compile error, not a warning. These fire on all clients and carry the player, so
`player.isLocal` is the usual first line.

---

## 5. Networked instantiation: `VRCObjectPool` and `VRCObjectSync`

Udon cannot `Instantiate` arbitrary objects across the network. **`VRCObjectPool` is the sanctioned
mechanism**: a fixed array of GameObjects whose active states are synced.

```csharp
[SerializeField] private VRCObjectPool pool;
// owner only:
GameObject spawned = pool.TryToSpawn();   // returns null if the pool is exhausted
pool.Return(spawned);
```

- **Both calls are owner-only.** Take ownership of the *pool* first, or they silently do nothing.
- **`TryToSpawn` returns `null` when exhausted**: check it. The pool never grows.
- **Late joiners are handled for you**: active/inactive states replicate automatically, which is the whole reason to use the pool rather than rolling your own.
- **Initialise in `OnEnable`, not `Start`.** Pool objects are disabled at rest, and **a disabled behaviour never runs `Start` and silently misses sync** ([02 §7](02-project-architecture.md#7-initialisation-and-ordering)). The old `OnSpawn()` callback is **deprecated**: VRChat's guidance is to use the ordinary enable event instead.

**`VRCObjectSync`** replicates Transform and Rigidbody:

- **`FlagDiscontinuity()`** before teleporting, or the move is smoothed and looks wrong.
- **`SetGravity` / `SetKinematic` are owner-only**, *and they are the only legal route*: with a `VRCObjectSync` attached, writing `rigidbody.useGravity` or `rigidbody.isKinematic` directly is a silent no-op. The component owns those properties and treats them as synced state.
- **`Respawn()`** returns the object to its start pose and zeroes velocity.
- Do not drive a `VRCObjectSync`'d transform from Udon on a non-owner; the two fight.

---

## 6. Master, instance owner, and who decides

```csharp
Networking.IsMaster          // local player is the instance master
Networking.IsInstanceOwner   // local player created this (private instance types only)
Networking.LocalPlayer
```

- **The master is not an authority: it is a default owner.** Any client can be lying about anything; `IsMaster` is convenient for "someone must do this once", not for permission. Real authorization is [06 §8](06-network-event-dispatch.md#8-the-trust-boundary) and `OnOwnershipRequest`.
- **The master changes when the master leaves.** Anything keyed on it must re-evaluate; track by display name rather than by cached reference ([07 §1](07-player-systems-and-identity.md#1-player-tags-are-the-missing-static-storage)).
- `IsInstanceOwner` is `false` in public instances; do not gate core features on it.

---

## 7. Persistence: `PlayerData` and PlayerObjects

Two independent stores, **100 KB per player per world each**.

### `PlayerData` — key/value

```csharp
// writes: LOCAL PLAYER ONLY, no player argument
PlayerData.SetInt("score", 42);
PlayerData.SetString("name", s);        // also: Bool, SByte, Byte, Bytes, Short, UShort,
                                        // UInt, Long, ULong, Float, Double, Quaternion,
                                        // Vector2/3/4, Color, Color32
// reads: any player
if (PlayerData.TryGetInt(player, "score", out int score)) { … }
bool has = PlayerData.HasKey(player, "score");
```

Four rules that decide whether this works at all:

1. **Wait for `OnPlayerRestored` before reading *or* writing.** Writing too early means your value is
   overwritten when the stored data arrives. This is the single most common persistence bug.
   ```csharp
   public override void OnPlayerRestored(VRCPlayerApi player) {
       if (!player.isLocal) return;
       // only now is this player's PlayerData valid
   }
   ```
2. **You cannot write another player's data.** Setters take no `VRCPlayerApi`; getters do.
3. **Keys cannot be deleted.** There is no remove. Design the key namespace as append-only, and version it
   (`inv.v2.slot0`) rather than repurposing a key whose old values are still out there.
4. **Prefer `TryGet*` over `Get*`.** A missing key on the `Get*` path gives you a default you cannot
   distinguish from a real stored zero, the same sentinel problem as
   [04 §2](04-data-structures-and-boxing.md#2-sentinels), except here you have a real `bool` available.

**`OnPlayerDataUpdated(VRCPlayerApi player, PlayerData.Info[] infos)`** fires at end of frame when any
player's data changes or arrives, the change-notification channel, so you do not poll.

**Budget it like sync bytes.** 100 KB is generous per key but finite across a world's lifetime; pack with
`SetBytes` and the techniques in [04 §8](04-data-structures-and-boxing.md#8-packing) rather than storing
one key per field.

### PlayerObjects

A prefab VRChat instantiates **once per player**, whose synced Udon variables persist when the object
carries a `VRCEnablePersistence` component. Two properties make it worth reaching for:

- **Ownership is designed out.** The object *is* owned by its player, so `Networking.GetOwner` is unforgeable sender identity; see [05 §4](05-sync-architecture-and-late-joiners.md#4-ownership).
- **Per-player state needs no registry**, no index allocation and no late-joiner protocol.

Two wiring rules that fail silently in the inspector: **scene components may not reference a PlayerObject
Template** (the Template may reference its own children or scene objects, the arrow only points one way),
and **you must not modify, destroy or re-edit a Template after it has been disabled**.

**Writes are rejected, not truncated.** Exceeding the quota logs an error and *your data is not saved*:
there is no partial write and no exception. Watch the wall before you hit it:

- `PlayerData.GetPlayerDataStorageLimit()` / `GetPlayerDataStorageUsage()` (and the PlayerObject equivalents) give you the numbers;
- `OnPlayerDataStorageWarning` / `OnPlayerDataStorageExceeded` (and `OnPlayerObjectStorage*`) are the callbacks.

Storage is measured **after compression**, so the effective ceiling depends on your data's entropy: measure,
don't estimate.

**Writes coalesce.** A player's whole data set is sent together on any local change, so if you write the same
key repeatedly in quick succession, remote clients **never observe the intermediate values**, only the
latest. Do not treat `OnPlayerDataUpdated` as an event stream; treat it as "something changed, re-read".
And **iterating all keys is slow** past a handful, reach for `TryGet*` on a known key rather than enumerating.

**The hard limit on both stores:** data must be saved **before the player leaves**: you cannot persist
from the local player's `OnPlayerLeft`. Write on change, not on exit.
