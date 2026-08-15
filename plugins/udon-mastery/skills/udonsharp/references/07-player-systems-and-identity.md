# 07 — Player systems & identity

---

## Contents

- [1. Player tags are the missing static storage](#1-player-tags-are-the-missing-static-storage)
- [2. Capability tokens](#2-capability-tokens)
- [3. Network IDs, actually](#3-network-ids-actually)
- [4. Tracking, IK and stations](#4-tracking-ik-and-stations)
- [5. Camera and viewpoint](#5-camera-and-viewpoint)
- [6. Voice and perception](#6-voice-and-perception)
- [7. UI and interaction](#7-ui-and-interaction)
- [8. Presence and visibility](#8-presence-and-visibility)

---

## 1. Player tags are the missing static storage

`SetPlayerTag` / `GetPlayerTag` is a per-player string dictionary that every behaviour on every client can
read and write. Udon forbids static mutable fields, so this is the only *shared* mutable namespace the
platform offers. Three jobs it does well:

- **a mutex across unrelated scripts**: "is this player's right hand already holding something?", answerable by code that has never heard of the code that set it;
- **broadcast status** that other systems poll without holding a reference;
- **a cross-client object handle**: store an object's full hierarchy path and resolve it with `GameObject.Find`. No registry, no synced index, no id allocation, and it works across clients because the path is identical everywhere.

**Check `Utilities.IsValid(player)` before *every* player access**, not merely as a null idiom: VRChat
states it as a precondition on getting or setting anything on a player. A stale reference is the normal
case, not the exceptional one.

**Store player IDs, never `VRCPlayerApi` references.** References go stale. Three consequences:

- `GetPlayerCount()` is **stale inside `OnPlayerLeft`**: defer a frame.
- Read `player.playerId` inside `OnPlayerJoined` even if you do nothing with it, so the value is retained for `OnPlayerLeft`. It looks like dead code and a linter will offer to delete it; comment it at the site.
- Track the master by **display name**, not by reference, so the tracking survives the master leaving.
- **The non-allocating `GetPlayers(VRCPlayerApi[] buffer)` silently truncates**: players beyond the buffer's length are simply missed, with no error and no count. Size it from `VRCPlayerApi.GetPlayerCount()`; a fixed 16- or 32-slot buffer is a bug waiting for a full instance.

When a `playerId` is not stable across a rejoin, rebind orphaned rows **by display name**: hot key is the
id, cold key is the name, and the whole rebind recomputes locally on every client with zero sync.

---

## 2. Capability tokens

The one cross-behaviour mutual-exclusion primitive Udon can express, and it composes:

- a **refcount `int`** for the true count, plus a **mirror `bool`** because `count > 0` is an EXTERN and reading a bool field is a native jump;
- **`[FieldChangeCallback]`** so any behaviour can claim or release by writing the variable;
- an **edge broadcast** when the count crosses zero;
- a **synthesised release event** for whatever input is being suppressed, so the suppressed system sees a clean "you were released" rather than an absence;
- each claimant keeps its **own private bool** so claim and release are idempotent on its side.

The time-based variant composes overlapping timers with no timer list: claim now, schedule a delayed
decrement. Overlapping claims simply extend the count.

---

## 3. Network IDs, actually

Read from the SDK rather than the docs (**Worlds SDK 3.10.4**):

- A network ID is per-**GameObject**, not per component.
- Components are addressed **by index in `GetComponents<VRCNetworkBehaviour>()` order**.
- IDs are matched across scene versions by the object's **hierarchy path string**.
- Range is MIN 10 / MAX 1,000,000.

**Therefore: reordering, adding or removing a network component re-slots every other component on that
object**, and renaming or reparenting breaks the cross-version match. ID-conflict tooling exists to handle
this: a migrator should **refuse rather than guess** when it cannot resolve a conflict unambiguously. Classify
the conflict types and let one unsafe class veto the whole batch.

---

## 4. Tracking, IK and stations

- **Split `LateUpdate` vs `PostLateUpdate` by *data source*.** Device pose is valid in `LateUpdate`; bones are the *IK output* and need `PostLateUpdate`. The folk rule ("always PostLateUpdate") over-generalises, and the distinction is what makes head-tracking and bone-following behave differently.
- **Keep two different "head in trigger" booleans**, one for rendering and one for teleporting, because holoport puts the head bone and the viewpoint in different places. Detect holoport by head-bone-vs-viewpoint divergence.
- **A permanent player station plus re-`UseStation`** is the post-teleport re-anchor. Bracket `TeleportTo` with `GetVelocity`/`SetVelocity` because it zeroes momentum.
- **Teleport by solving for the play-space origin**: `teleportRot * inverse(playerRot) * offset`, a composition that is easy to get wrong. Guard the ClientSim bypass.
- **`FlagDiscontinuity()` before teleporting a synced rigidbody**, and enforce ownership only when a `VRCObjectSync` actually exists.
- **Level the station transform for exactly one statement** so `UseAttachedStation` cannot bake in roll.
- **Seat calibration by successive approximation** with power-of-two step quantisation: converges in ~log₂ steps with no gain constant, is immune to an unknown loop rate, latches per axis independently once the error stays small, and only resends to late joiners once converged.
- **A self-rearming 5 s poll** for avatar-dependent bone availability, comparing with `.Equals(Vector3.zero)` rather than `==` because Unity's `Vector3 ==` is approximate.
- **`VRCPlayerApi` gives bone positions but no topology**, so a hard-coded 8-case child table plus point-to-segment projection is the substitute.
- **`VRCPlayerApi` physics values only update in `Update`**: detect staleness by *value equality on the sample*, not by clocks, and sub-step an accumulator around it.
- **Escaping `VRC_Pickup`'s transform smoothing**: reparent the visual mesh out of the pickup and drive it in `PostLateUpdate` from `GetTrackingData(hand)`; the pickup transform still exists and networks normally. The essential detail is a verification step that **re-derives the world transform from the offset it just computed and requires exact equality before engaging**, a self-validating derivation that refuses to activate when its assumption is false. **Guard-by-round-trip is the right substitute for the exceptions Udon lacks.**
- **Analog trigger** via `Input.GetAxisRaw` with Oculus axis names, unified with the desktop mouse by `Mathf.Max` *before* any logic. `InputUse` (the held state) debounces a continuous UI control better than a timer: preview locally during the drag, commit authoritatively on release. `InputLookVertical` doubles as a spare button while holding a pickup.

---

## 5. Camera and viewpoint

- **`VRCCameraSettings.ScreenCamera`** supplies position, rotation, FOV, aspect, pixel dimensions, near/far and `StereoEnabled`; **`GetEyePosition(Camera.StereoscopicEye)`** gives the eye offsets.
- **Do not build two grids for VR.** Build one at the eye midpoint and **conservatively dilate the frustum** by projecting each eye offset onto the camera basis: three `Vector3.Dot`s and one mono grid provably covers both eyes. Do it in `PostLateUpdate`, so camera motion has settled. If the camera is null, disable the feature rather than guessing.
- **A never-enabled, cullingMask-0 dummy camera still has valid per-eye stereo matrices**, a projection-matrix oracle you can read from Udon.
- **VRChat disables extra cameras on world load**, and Udon `Start` runs *after* that pass, so re-enable from `Start()`. Park the rig ~10 000 000 units away: **physical isolation beats layer isolation**, because layers are a scarce global resource in a shared world.
- **`_ProjectionParams.z` as a camera fingerprint** for self-hiding utility geometry.

---

## 6. Voice and perception

The most transferable idea here: **rewrite your own perception instead of syncing anything.**

A vehicle intercom needs no audio graph and no synced state. Every client walks an already-synced
membership list and calls `SetVoiceDistanceNear` / `SetVoiceDistanceFar` / `SetVoiceGain` for its *own*
perception of each player. Zero sync bytes, no ownership, no late-joiner problem, because the state being
changed is local by definition.

The same principle in a different medium: **collider layers as client-local per-observer relationships.**
The same object has two collision identities on two clients, at zero network cost, which gives a targeting
system free self-exclusion. `Rigidbody.includeLayers` / `excludeLayers` (Unity 2022, whitelisted) do
the same per object without touching the global collision matrix; set **both**, so the filter is
authoritative regardless of the project's matrix. The usual `OnTriggerEnter` filtering still pays the
physics cost of every unwanted contact.

---

## 7. UI and interaction

- **VRChat UI interactivity is physics.** Toggle `Collider.enabled` under `VRCUiShape`.
- **Quest has no `InputField`**, so put a query DSL in a `Text` field with a two-field fallback for one logical input.
- **`SetIsOnWithoutNotify` / `SetValueWithoutNotify`** break the UI→Udon→UI feedback loop by removing the failure mode rather than guarding it, with no flag to clear and therefore no `finally` needed. When you *do* want the side effects, suppress at the source and then dispatch manually, in your order.
- **Optimistic UI with an authoritative read-back on the very next line** works precisely *because* Udon has no async.
- **Pick the fix for a spurious UI event by *how* it is distinguishable**: by scope, by authorship, by human-vs-code (drag events), or by timing. Four different problems, four different answers; a fix chosen for the wrong one does not suppress the event.
- **List virtualisation in Udon**: an edit-time-instantiated fixed row pool, an offset window, and a faked scroll range (content rect sized to the full list, `SetValueWithoutNotify` on the scrollbar).
- **Transient toasts that self-heal by re-invoking the canonical renderer**: keep renderers idempotent and parameter-free and "undo my override" comes for free.

---

## 8. Presence and visibility

- **Renderer culling as a zero-cost distance + frustum trigger**: a `LODGroup` plus a **material-less `MeshRenderer`** (bounds-culled, never drawn) plus an empty second LOD level as a cull-out sentinel gives apparent-size testing with no distance maths and **no Udon instructions while stable**. The editor configures an *engine subsystem* rather than precomputing numbers.
- **`_onBecameVisible` / `_onWillRenderObject` / `_onRenderObject`** are reachable entry points U# does not expose: declare a public method named after them.
- **Synthesise an enter/leave lifecycle over a stateless raycast**, with the receiver owning its own edge detector.
- **Detect ownership theft by treating a contradiction as an event**: "I received a state update for an object I think I own".
