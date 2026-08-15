# Udon Mastery

A Claude Code plugin for **VRChat world development in UdonSharp**.

Udon is a restricted VM: most of C# is unavailable, and the unavailable parts differ from the commonly
assumed set. The constraint list commonly circulated for UdonSharp is more restrictive than the compiler:
it forbids constructs that compile fine (`partial class`, method overloading, `params`, default
parameters, static methods, generic static helpers). The genuine restrictions matter just as much, and
they surface late — `List<T>` satisfies an IDE and fails at upload.

An agent writing UdonSharp guesses at that boundary. This plugin replaces the guessing with a reference
read out of the compiler, and a lint pass that catches what slips through anyway.

## What this is — and what it is not

This is a **depth** reference on the layer where UdonSharp stops behaving like C#: the compiler boundary,
the instruction-level cost of the VM, sync as a network protocol, and the techniques that exist only
because Udon forbids the ordinary answer.

Scene setup, layers, lighting, the Build Panel, uploading, video players, web and image loading, UI
toolkits and the SDK API reference sit outside that scope; VRChat's own documentation covers them.

| Covered here | Not covered here |
|---|---|
| Does this C# construct survive the compile? | How to write C# |
| What an operation costs in VM instructions | Scene setup, layers, lighting, occlusion |
| Sync, ownership, late joiners, replay defence | Building, testing and uploading a world |
| Driving shaders and GPU work from Udon | The SDK component and API catalogue |
| Editor-time tooling, build hooks, codegen | Video players, web/image loading, UI toolkits |
| Why the widely-circulated constraint list is wrong | Getting started with VRChat world development |

An omission here means the topic is out of scope, never that the construct is unsupported.

## What's in it

**A skill (`udonsharp`)**: the decision layer. Does this construct compile? Which sync mode? Why did
`SendCustomNetworkEvent` silently do nothing? A quick-reference table of ~35 constructs with the
workaround for each, sync and networking semantics, and the unifying rule that predicts the whole list:
*anything Roslyn erases before UdonSharp sees the syntax tree survives.*

**16 topic references**, loaded one at a time on demand and costing nothing until the task needs them:

| | |
|---|---|
| Mental & cost model | how Udon executes, and how to falsify a constraint yourself |
| EXTERN economics | byte-exact instruction costs, heap-symbol accounting, the cross-behaviour call price |
| Project architecture | one program or many; abstraction without interfaces; the `COMPILER_UDONSHARP` seam |
| Events & callbacks | dispatch without delegates; argument channels; the coroutine substitutes |
| Data structures | parallel arrays, slot handles, sentinels, when *not* to use `DataList`/`DataDictionary` |
| Sync & late joiners | manual sync as a protocol, ownership, idempotency, bandwidth budgets |
| Network dispatch | `[NetworkCallable]` vs `[UdonSynced]`, hand-rolled serialisers, replay defence |
| Player systems | player tags, network IDs, tracking data, stations, voice |
| Performance | how to spend a frame; scheduling vs branching; "off state costs nothing" |
| Udon↔GPU bridges | global arrays, property blocks, CustomRenderTextures, readback |
| VRC shader toolbox | depth, stereo, grab passes, versioned includes, batching traps |
| Editor-time tooling | build hooks, proxy-vs-backing, injection, codegen, non-destructive mutation |
| Debugging | profiling, fault detection, testing a VM with no test framework |
| Math & spatial | closed forms, coordinate frames, quaternion compression |
| World interaction | `Interact()`, pickups, triggers, object pools, `PlayerData` persistence |
| Anti-patterns | myths, traps, and things that only fail in the uploaded world |

**A 252-entry technique catalog** (`T-001`…`T-252`) for looking up a named technique directly.

**A lint hook.** After every `Write`/`Edit` of a `.cs` file that declares a `UdonSharpBehaviour`, it flags
constructs that pass your IDE and then fail the Udon compile (`List<T>`, LINQ, `try`/`catch`, coroutines,
`async`, multidimensional arrays, interfaces, user structs, delegates, nullable value types, object
initializers, `switch` expressions, `partial` methods, static mutable fields), plus three silent traps: a
missing `[UdonBehaviourSyncMode]`, `#if UNITY_EDITOR` used as an Udon guard (it isn't one, because U# compiles
*inside* the editor), and `renderer.material`, which clones the material and leaks permanently in a world that
never unloads.

It skips `/Editor/` folders and correctly ignores anything inside
`#if UNITY_EDITOR && !COMPILER_UDONSHARP`, where unrestricted C# is legal.

It also audits your **remote surface**: every `public` method that is not `_`-prefixed and not a built-in
event — everything a modified client can invoke by name. Deliberate endpoints are acknowledged in place, so
a maintained file goes quiet:

```csharp
[NetworkCallable]                 // modern endpoints: already exempt
public void _Apply(int slot) { }

// udon-lint: network-entry       // legacy endpoints: say so once
public void OpenGate() { }
```

Set `UDON_LINT_REMOTE=0` to switch that check off and keep the rest.

## Security: the `_` prefix is a real boundary, and a narrow one

Any player in the instance can invoke your Udon methods by name; a modified client just sends the name.
There is no allow-list of callers, and for a **legacy** event no API tells you who sent it. (A
`[NetworkCallable]` handler can read `NetworkCalling.CallingPlayer`, useful for routing, but it is set by
the receiving client from what the transport reports, not proof of authority.)

The platform's mechanism here is that a legacy `SendCustomNetworkEvent` naming a method that starts with `_`
is **refused by the receiving client**. Enforcement on the receiver is what makes it work: a hostile client
can put any string on the wire, and every legitimate client still refuses to run a `_` method.

But it is not access control: local `SendCustomEvent`, UI button clicks and cross-behaviour calls all still
reach a `_` method, and `[NetworkCallable]` deliberately overrides it. The skill spells out the full
reachability table, the GameObject-wide fan-out of legacy events, and the discipline that follows: prefix
everything with `_` *except* your real entry points, then treat those as untrusted input.

Adopting that discipline introduces a new failure mode: a method that *had* to be networked, quietly
underscored, whose events are then refused at runtime while local testing looks fine. The linter treats
`SendCustomNetworkEvent(..., nameof(_Method))` as a hard finding for this reason.

## Install

```
/plugin marketplace add Grim-es/udon-mastery
/plugin install udon-mastery@shotariya
```

The lint hook needs `node` on `PATH`. Without it the skill still works; only the hook goes quiet.

## Scope

Beyond the boundary drawn above, it deliberately says nothing about naming, namespaces, folder layout or
wiring style. Those are per-project and belong in your own `CLAUDE.md`, which the skill defers to
explicitly.

**Everything is pinned to Worlds SDK 3.10.4.** Constraint claims cite compiler source by `file:line`,
relative to `Packages/com.vrchat.worlds/Integrations/UdonSharp/Editor/`, paths that resolve in your own
project. Line numbers drift by a few lines between UdonSharp versions; the surrounding symbol name is the
stable part of a citation. On any other SDK version, re-verify before designing around a constraint. The
compiler in your own `Packages/` folder is authoritative over this document.

Runtime *timing* claims are the weak spot: the instruction-count arithmetic is exact, the "therefore this
is faster" inferences built on it are not measured, and the reference says so wherever it matters.

## Credit

Almost nothing here was invented. It was read out of the UdonSharp compiler and out of public packages by
people who solved these problems first and shipped the result to strangers: LTCGI, ProTV, LightSync,
AudioLink, SaccFlight, VRC Light Volumes, VRSL, VRCFury, shadertrixx, ParaDraw and others. No code from
any of them is reproduced here; what is recorded is technique. The full list is in the skill's reference
index.

Each entry points to the original work rather than replacing it; read the source directly.

Corrections are welcome.

## License

MIT. See [LICENSE](LICENSE).
