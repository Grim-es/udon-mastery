# 00 — Mental & cost model

Read this first; the rest of the reference follows from it.

---

## Contents

- [1. Udon is an interpreter, so the unit of cost is the VM instruction](#1-udon-is-an-interpreter-so-the-unit-of-cost-is-the-vm-instruction)
- [2. The Roslyn-erasure rule](#2-the-roslyn-erasure-rule)
- [3. Test constraints; do not inherit them](#3-test-constraints-do-not-inherit-them)
- [4. `#if` is the master key, and there are two defines](#4-if-is-the-master-key-and-there-are-two-defines)
- [5. What actually runs](#5-what-actually-runs)
- [6. Failure has no exceptions, so it has a shape](#6-failure-has-no-exceptions-so-it-has-a-shape)
- [7. The design instinct this all adds up to](#7-the-design-instinct-this-all-adds-up-to)

---

## 1. Udon is an interpreter, so the unit of cost is the VM instruction

The unit of cost is the instruction, not the arithmetic operation or the line of code.

> **Optimise toward the *largest* built-in that does the job.**

One EXTERN into the host beats four VM instructions, even where ordinary C# instinct says the opposite:
`quat * mirrorQuat` (one EXTERN) beats four swizzle-and-negate operations, though in normal C# the swizzle
is free and the quaternion multiply is not.

Apply it:

- `Vector3.Angle` is *several* externs; precompute a cosine and use `Dot`. But a *closed-form* damped oscillator should call `Mathf.Sqrt`/`Exp`/`Sin`/`Cos` outright, because one EXTERN beats a polynomial approximation's worth of VM instructions.
- Three nested `Vector3.Lerp` calls beat writing the Hermite basis out in scalars.
- `Array.Copy` is one EXTERN where a 1023-element copy loop is ~1023 interpreted iterations.
- `Array.IndexOf((Array)arr, item)` is one EXTERN where the hand-written `for` is N.
- `foreach` over an array beats the hand-written `for`: it hoists the `.Length` extern above the loop.

The second half of the model: **moving data costs more than computing it.** `COPY` is 20 bytes, `EXTERN` is
8 (see [01](01-extern-economics.md)). Optimise for *fewer distinct named values*, not fewer operations, and
distrust ordinary style advice (small locals, extracted subexpressions, helper methods) that a register
allocator normally makes free. Udon has no register allocator, no dead-store elimination, and never reuses
a temporary.

The third part of the model: **crossing a behaviour boundary is expensive; calling within one
is not.** An intra-behaviour call is a label jump with zero externs. A cross-behaviour call is
`SetProgramVariable`×args + `SendCustomEvent` + `GetProgramVariable`. Verified against both the emitter and
emitted assembly.

---

## 2. The Roslyn-erasure rule

> **Anything Roslyn erases before UdonSharp sees the syntax tree survives. Anything that reaches the tree
> intact is subject to UdonSharp's rules.**

This one rule predicts the entire corrected constraint list in the [README](README.md#constraint-corrections-read-this-before-anything-else),
and it predicts the exceptions too:

- `partial` **class** is erased by Roslyn → works. `partial` **method** survives into the tree → explicitly rejected (`MethodSymbol.cs:155`).
- `using static` and `using X = N.T` aliases are erased → work, and are the cleanest substitute for the adapter pattern Udon forbids.
- Method overloading is resolved by Roslyn, then name-mangled by U# (`__<n>_<name>`) → works.
- `params` is expanded at the call site by Roslyn → works at a *static* call site, and cannot be fed a runtime array.
- Default parameter values are filled in by Roslyn at the call site → work.
- `const` is folded by Roslyn → `const bool` deletes dead branches entirely. Verified: shipped code carries a `#pragma warning disable CS0162` that is only necessary because the fold happens.
- Generics are *monomorphised* by U#: an open generic definition is never bound or emitted, only constructed instantiations are (`MethodSymbol.cs:84-99`). A generic static helper works when the type argument is a compile-time constant, and fails the moment `T` needs an operator, a `new()` constraint, or is forwarded from another generic.
- `#if` is a preprocessor concern that runs before everything, which makes it the master key (§4).

The rule also tells you what will *never* work, no matter how the SDK evolves: interfaces, delegates, user
structs, exceptions, and static mutable fields all require runtime support the VM does not have.

---

## 3. Test constraints; do not inherit them

The constraint list commonly circulated for UdonSharp forbids more than the compiler does, and consistently in
that direction. The corrected list is in the
[README](README.md#constraint-corrections-read-this-before-anything-else). What matters here is the *method*,
because the SDK moves:

1. **Read the compiler.** `Packages/com.vrchat.worlds/Integrations/UdonSharp/Editor/Compiler/` is the ground truth. Compiler-rejected constructs have named diagnostics (`CE_LocalMethodsNotSupported`, `CE_PartialMethodsNotSupported`, `CE_UdonSharpBehaviourGenericMethodsNotSupported`); everything else falls through `DefaultVisit → CE_NodeNotSupported`.
2. **Treat pervasive use in a published library as verification.** A technique used throughout a package shipped to strangers who cannot debug it has already been tested against a compiler by someone with upload access.
3. **Distinguish "the compiler rejects it" from "it is not exposed to Udon."** The first is a named diagnostic; the second is `CE_UdonMethodNotExposed`. Exposure is a *whitelist*, discoverable by setting `UDONSHARP_DEBUG` and running the Node Definition Grabber, which dumps every exposed EXTERN.
4. **When a BCL method is not whitelisted, inline the reference implementation.** A blocked surface is almost always a thin wrapper over exposed primitives: `ColorUtility.ToHtmlStringRGB` is a few lines of `ToString("X2")`.
5. **Look for a pre-generics overload.** `Array.IndexOf<T>(T[], T)` is generic and unavailable; `Array.IndexOf(Array, object, int, int)` is not, and *is* exposed. `System.Array`'s legacy non-generic surface is a whole escape hatch.

All constraint claims here are read from **Worlds SDK 3.10.4**. On any other version, re-verify first.

---

## 4. `#if` is the master key, and there are two defines

| define | means |
|---|---|
| `UDONSHARP` | the UdonSharp package is installed in this project |
| `COMPILER_UDONSHARP` | **this compilation is the Udon pass** |

`UNITY_EDITOR` is true *while UdonSharp is compiling*, so `#if UNITY_EDITOR` alone hides nothing from the
VM. The correct gate for editor-only code that must never reach Udon is
`#if UNITY_EDITOR && !COMPILER_UDONSHARP`. Confusing the two produces code that compiles in the editor and
fails at upload: the commonest way to break dual-compiled code.

With the right gate, **unrestricted C# lives in the same file as Udon code**: generics, delegates, `struct`,
`List<T>`, `Dictionary<,>`, LINQ, `try`/`catch`, `System.IO`, `Task`/`async`, reflection,
`ConditionalWeakTable`. One source tree can compile **four ways** (Udon build, Udon editor-proxy, standalone
`MonoBehaviour`, editor-only C#), with `#if` on class-declaration lines, on `try`/`finally` brace lines, on
individual fields and on `using` aliases. See [02](02-project-architecture.md) for the shape.

Two consequences worth internalising:

- **Never `#if` a *field* on a behaviour.** VRChat documents conditionally adding or removing fields on an `UdonSharpBehaviour` as unsupported, and the mechanism explains why: U# compiles per active build target, so a guarded field changes the serialized program asset's heap-symbol count and layout, and a platform-specific bug stays invisible until you switch targets. Declare the field unconditionally and guard only its *uses*. `#if` on *method bodies and types* remains a legitimate program-size tool.
- **A `#if`-guarded field breaks UdonSharp's play-mode proxy.** In Play mode U# keeps the C# proxy in sync by reflecting over **every instance field, including non-serialized private ones**, so an editor-only cache exists on the C# type but not on the Udon side and the layouts disagree. Hold that state in a `static readonly ConditionalWeakTable<TBehaviour, EditorState>` keyed by the instance, and reintroduce the old field *names* as private forwarding properties so no call site changes. It is **field presence**, not serialization, that the proxy reflects.

---

## 5. What actually runs

A `UdonSharpBehaviour` is a **C# proxy**. The thing that executes is a sibling `UdonBehaviour` holding a
serialized program with its own string-keyed heap. Consequences that reach almost every topic here:

- A "reference to another U# behaviour" **is** an `UdonBehaviour` at runtime; the typed C# view is a compile-time fiction, which is why cross-behaviour access is priced the way it is and why editor code must call `GetBackingUdonBehaviour` before injecting anything.
- Editor code that writes `myBehaviour.field = x` writes the **proxy**, which is silently discarded at build. See [11](11-editor-time-tooling.md).
- The heap is a flat, string-keyed namespace that is externally readable and writable. Public variables are not special; U# itself puts `__refl_typeid`, `__refl_typename` and `__gintnl_*` symbols in the same space.
- Only **0-parameter** methods keep their source name in the Udon symbol table. Everything else is mangled. So the stable public entry point is the 0-arg method, and `[NetworkCallable]` is the only stable *named* entry point that takes parameters.
- The U# `override` list is a hand-curated convenience layer over Udon's **string entry-point table**. The table is the authority: reach an entry point U# doesn't expose by declaring a public method named after it (`_onBecameVisible`, `_onWillRenderObject`, `_onRenderObject`). Grep `UdonBehaviour.cs` for `RunEvent("_...")`.
- Declaring certain entry points (`_update`, `_onWillRenderObject`, `_onTriggerStay`, `_onCollisionStay`, `_onAnimatorMove`, `_onAudioFilterRead`) makes `UdonBehaviour.ProcessEntryPoints` attach a hidden proxy MonoBehaviour. **Not declaring `Update()` is a real optimisation.**
- `enabled = false` suppresses `Update`/`LateUpdate` while the behaviour stays fully callable by `SendCustomEvent` and by public methods. That is a *free* removal from the per-frame dispatch list, which an early-return guard is not.

---

## 6. Failure has no exceptions, so it has a shape

There is no `throw`, no `catch`, no stack trace, and no debugger. Adopt these as a whole rather than
piecemeal:

- **Sentinels instead of nulls**, chosen so they are already correct under whatever relation consumes them: `int.MaxValue` as "unregistered" sorts last with no guard; `float.PositiveInfinity` as "nothing in range" makes `if (d < threshold)` correct by default where `0` would invert it.
- **`Try…` + `bool` + `out`** as the exception-free downcast.
- **Guard by API shape**, not by validation, when a call genuinely can fault: expose a safe no-arg public method for UI to bind to, and keep the unguarded overload for callers who have already validated. Say so at the declaration, because there is no other enforcement.
- **Watchdog counters** in place of `try`: a hand-rolled `iterLimit--` in any loop whose bound came off the network.
- **Graceful degradation over failure**: `default:` stacked onto a real `case` so definite assignment is satisfied with no `throw`; render something visibly wrong rather than nothing; an allocator returning null so a disabled library silently no-ops.
- **Structurally return-free critical sections**, because there is no `finally`: hoist every validation above the mutation, make the restore idempotent, and call it *first* so a previously-leaked state repairs itself. The invariant is enforced by code shape, not by discipline.
- **Poll for corpses.** The VM *disables* a behaviour that faults, so polling `UdonBehaviour.enabled` at 1 Hz is the only fault detector available, and it needs no cooperation from the watched code.

Two failure modes are not soft:

- **NaN crashes the VRChat client.** Clamp every inverse-trig argument.
- **An out-of-range index halts the behaviour.** Precompute a safe length rather than bounds-checking in the loop, and **never ship an empty array**: pad it at build time with a dummy the existing rejection path already discards.

---

## 7. The design instinct this all adds up to

> **Decide once, at the cheapest possible moment, and make the runtime path a table lookup.**

- *At design time*: classify every case as "affine image of a template" or "genuinely varies", and let only the second class ever run general code.
- *At compile time*: `#if`, `const bool`, default arguments, `partial`, all of which remove instructions rather than skipping them.
- *At edit/build time*: bake the registry, bake the payload, bake the index, bake the shader `#define`s, bake the whole dataset into a texture. See [11](11-editor-time-tooling.md).
- *At warm-up*: pools that grow and never shrink; property blocks created once; a service reference resolved on first use and thereafter a single bool test.
- *On the GPU*: anything that varies per *viewer* rather than per *object* (billboarding, occlusion, edge distance, debug lighting) costs the VM nothing at all. See [09](09-udon-gpu-bridges.md).

And its corollary, the through-line of the whole reference:

> **Choose the storage medium, not just the algorithm.** Udon's cost model punishes *touching* data far
> more than storing it, so the winning move is repeatedly "put it somewhere Udon never has to iterate":
> VRAM, a baked texture, a renderer's property block, the `.w` lane of a `Vector4`, a `sortingOrder` int,
> the transform child list, the server's retained sync state.
