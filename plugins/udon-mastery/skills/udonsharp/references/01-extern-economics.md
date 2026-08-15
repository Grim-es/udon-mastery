# 01 — EXTERN economics

The numbers below are read out of the UdonSharp emitter
(`Packages/com.vrchat.worlds/Integrations/UdonSharp/Editor/Compiler/`, **Worlds SDK 3.10.4**) and confirmed
against emitted `.uasm`.

> **Caveat, stated once and meant throughout: these are *static* costs (instruction bytes, heap symbols,
> program size). No wall-clock number here is measured.** Treat "therefore this is faster" as a well-founded
> inference, not a benchmark.

---

## Contents

- [The instruction table](#the-instruction-table)
- [Heap accounting](#heap-accounting)
- [Assignment-scope destination forwarding](#assignment-scope-destination-forwarding)
- [Control flow](#control-flow)
- [`[RecursiveMethod]`](#recursivemethod)
- [Array literals](#array-literals)
- [The cross-behaviour boundary](#the-cross-behaviour-boundary)
- [Program size versus per-call work](#program-size-versus-per-call-work)
- [Measuring anything](#measuring-anything)

---

## The instruction table

Read directly off `AssemblyInstruction.cs`'s `Size` overrides (**Worlds SDK 3.10.4**); verify it yourself
there in ten seconds. Note these are **UdonSharp emitter constructs**, which do not map one-to-one onto the
published Udon VM opcode list: `RET`, `EXTERN_SET`/`EXTERN_GET` and the zero-size tags are things the
emitter writes, not ISA entries. Budget with this table; do not expect the VM documentation to match it.

| instruction | bytes |
|---|---|
| `COPY` | **20** |
| `RET` | **20** |
| `JUMP_IF_FALSE` | 16 |
| `PUSH` | 8 |
| `EXTERN`, `EXTERN_SET`, `EXTERN_GET` | 8 |
| `JUMP`, `JUMP_INDIRECT` | 8 |
| `NOP`, `POP` | 4 |
| `Comment`, export/sync tags | 0 |

(`RetInstruction` carries a source comment reading `// Push, Copy, JumpIndirect`, which would sum to 36. The
declared `Size` is 20. Trust the declared size; the comment is stale.)

An extern call is `1 PUSH per argument + 1 PUSH for the return slot + 1 EXTERN`. So a 2-argument extern is
32 bytes. A **`COPY` costs more than twice an `EXTERN`**, which is the whole reason the first thesis of
this file is *moving data costs more than computing it*.

`Comment` costing zero bytes is not trivia: it is what makes **deletion-as-substitution** possible. An
instruction you want to remove can be replaced with a zero-size tombstone instead of re-indexing the whole
program.

---

## Heap accounting

**Heap size = distinct values + distinct extern signatures.** Call *count* is free; API **breadth** is not.

- Every unique extern signature you touch costs a heap symbol. All `UnityEngine.Object`-derived arrays collapse to **one** signature pair, so array indexing across many Unity types is cheaper than it looks.
- **The emitter never reuses a temporary.** Every expression temp is a permanent heap symbol, forever. Block-scope coalescing recovers thousands of symbols in a large program.
- **`__this` is duplicated per use site**: one heap symbol for every place the behaviour references itself.
- Every short-circuit `&&`/`||` expression costs **one permanent internal heap symbol** and calls `TopTable.DirtyAllValues()`, invalidating every copy-on-write-cached value in scope. They are a de-optimisation barrier even though they emit no negation extern.
- Duplicate **literals are free** (global constant dedup), so `const` hoisting for "reuse" is noise. Type-*mixed* literals are not free: `1` and `1f` are different constants.
- `const` scalars fold into the instruction stream with **no heap symbol**. A `static readonly` would not, and is banned anyway; use `readonly` **instance** fields as the substitute.

### Practical consequences

- **Hoist hot-path locals to fields.** A local's *initialiser* is emitted as instructions on every call, and Udon has no dead-store elimination.
- **Use class fields as scratch registers** in a giant `switch`, including the `for` induction variable, to cap the symbol count.
- **Keep a `hasX` bool mirror of every inspector reference.** Unity's `!= null` is an EXTERN (`op_Implicit`); branching a bool field is a native jump. The same bools then double as array-allocation gates and re-entrancy latches. Same idea for counters: a refcount `int` plus a mirror `bool`, because `count > 0` is an extern and reading a bool is not.
- **Hoist null checks** via assignment-in-condition at `Start`.
- **String interpolation has a cliff at >3 holes**: one extern becomes `holes+1` externs plus a permanent `object[]`.
- **Array indexing is an EXTERN.** This is why parallel arrays are cheap in *structure* but not in *access*, and why hot loops cache into locals-hoisted-to-fields.

---

## Assignment-scope destination forwarding

`x = SomeExtern();` writes the result **directly** into `x`'s heap slot. The moment you wrap it (a cast, a
nested call, an implicit conversion), the emitter allocates a scratch slot and adds a `COPY`: **+20 bytes
and +1 permanent symbol per site**.

```csharp
float f = GetFloat();            // direct
double d = GetFloat();           // conversion -> temp + COPY
Foo(GetFloat());                 // nested     -> temp + COPY
```

Two idioms exploit the same machinery deliberately, and both appear in SDK-adjacent code:

- a single `object _dump` field to absorb discarded return values, so the emitter stops minting a fresh symbol per discarded call;
- `if (_flag = expr)` to funnel branch temporaries through one named field.

Both are ugly and both are correct: they trade readability for a bounded symbol count in code that would
otherwise mint hundreds. Use them where the site count is high, not everywhere.

---

## Control flow

- **`switch` compiles to a heap-resident `uint[]` jump table**, genuinely O(1). A `switch` over an *extern* enum is rewritten to its underlying int deliberately, with the compiler's own comment saying it is "to prevent a ton of `.Equals` calls and allow easy jump table optimizations". A chain of `if (e == SomeEnum.X)` gets none of that. The cost: every arm becomes a jump target, which is an optimisation barrier for anything that wanted to reason across the block.
- **Jump-chain flattening**: exiting depth-*n* nesting costs *n* jumps. Guard-clause style is measurably shorter code, not just cleaner code.
- **`!` is an EXTERN** (`op_LogicalNot` → Udon's `UnaryNegation`), *except* in an `if` condition, where the binder strips a top-level negation and swaps the branches. It does so in a `while` loop, so `!!x` collapses too. Everything else still pays: `while (!x)`, `bool y = !x;`, `return !x;`, a ternary condition, and any `!` written *inside* an `&&`/`||` chain.
  - So do **not** write `if (cond) { } else { … }` with an empty then-branch to dodge the negation extern. It was a valid trick before the peephole; on 3.10.4 it is redundant, and it is worth deleting on sight.
- **Tail-call elimination**: deleting the pushed return address saves 4 instructions per call. It is one of five COPY-elimination peepholes, each corresponding to a specific emitter waste pattern, the most general being "an extern always returns into a scratch slot and then copies".

---

## `[RecursiveMethod]`

Roughly **4N+3 externs per call**, where **N is every live local, not just the parameters**. The mechanism
is a manual stack save/restore of the frame.

Mitigations, in order of preference:

1. **Don't.** Write the iterative version with an explicit `int[]` stack. For quicksort in particular this is the standard answer.
2. If you must, **hoist scratch locals into fields** so they are not part of the saved frame.
3. Remember `[RecursiveMethod]` **disables the compile-time array-literal allocation** (see below), so a recursive method that builds arrays pays real allocations.

A related trap: `[RecursiveMethod]` protects *locals*. It does **not** protect shared state, so a
re-entrant event dispatch must snapshot and clear its per-listener suppression flags before iterating.

---

## Array literals

`new[] { a, b, c }` is **compile-time allocated into one shared global**. That means:

- allocation is free at runtime, which is why array-literal lookup tables are the right shape for constant data;
- **the array is shared between all executions of that expression**: an aliasing hazard if anything writes into it;
- the optimisation is disabled inside `[RecursiveMethod]`.

---

## The cross-behaviour boundary

The number that shapes the most architecture in this reference:

| | cost |
|---|---|
| intra-behaviour call | a `JUMP` to a label + `RET`. **Zero externs.** |
| cross-behaviour call | `SetProgramVariable(string, object)` per argument (string-keyed heap write + a box) + `SendCustomEvent(string)` + `GetProgramVariable` to read anything back |

≈ **120 bytes / 4 externs** for a small call, versus zero. Verified twice independently: by reading the
emitter (`BoundUserMethodInvocation` pushes a `__gintnl_RetAddress_*` constant and emits a `JUMP`), and by
reading the emitted assembly of injected calls.

The corollaries drive [02](02-project-architecture.md):

- **Merge chatty behaviours.** `partial class` across many files keeps module structure while staying one program, so inter-module calls stay label jumps.
- **Make each crossing do as much work as possible.** One call draws a whole shape, not twelve edges; a library does its own type dispatch internally so consumers never branch.
- **Default arguments are an EXTERN reduction, not just ergonomics**: an argument the caller does not pass is one fewer heap write.
- **Prefer 0-argument `void` methods** at the boundary. They are also the only methods that keep their source name.
- **Mirror what you push.** A driver behaviour that pushes five settings to a worker every frame should keep a local mirror and skip the write when unchanged: steady state then performs **zero** cross-behaviour writes and only the one dispatch. A write-through cache of *another object's* state, held by the writer; the inverse of the usual read cache, and specific to a cost model where the boundary crossing is what you pay for.
- **Cache the `Transform`, not the behaviour.** `instance.transform` is a cross-behaviour read *and* an extern; hoist transforms into a parallel array at rebuild time and both leave the per-frame loop.
- **`GetComponent<TUdonSharpBehaviour>()` is not cheap either**: it lowers to `GetComponents(typeof(UdonBehaviour))` plus a string-keyed `GetProgramVariable` heap probe and a boxed-long compare **per component**. That is the arithmetic behind "resolve references at build time".

---

## Program size versus per-call work

Udon has plenty of program size and no per-call budget, so the trade usually runs one way: **generate code,
don't build tables.**

~90 generated zero-argument accessors (`private uint load_pc() { return decode(26, 0, 3); }`) beat an
`int[] FIELD_OFFSETS` plus one `Load(int id)`. The table is smaller source but *worse* Udon (an
array-index extern and a heap symbol per lookup, no constant folding), where the generated wall passes
literal ints straight into the decoder. Same reasoning: duplicate a transform loop body rather than
factoring it, when a shared helper would add a call per element.

The counterweights:

- **Monomorphisation is linear in distinct instantiations.** A generic static helper emits one body per distinct `T`. Keep such helpers small.
- **Empty virtuals on a base class are emitted into every subclass program.** A 40-member base multiplied across every plugin type is real program size, so **base-class granularity is a program-size decision**: split one publisher's base into several differently-sized bases (40 / 5 / 2 / 1 members) and let each subclass inherit only what it needs.
- **Logging must be compiled out, not gated by a bool.** `if (debugLogging) Debug.Log($"...")` still pays: the interpolation is evaluated before the call, and every literal is a permanent heap symbol. A *scripting define* is the only zero-cost switch, and U# runs Roslyn first so the string machinery never reaches the assembler. `[System.Diagnostics.Conditional("DEBUG")]` does the same for `void` methods and elides **the arguments too**. Where neither is available, hoist the gate to a precomputed `IsDebugEnabled` field and guard at the *call site* (Udon has no lazy arguments), and put the `#if` at **both** the helper and the call site, because the argument expression still costs.

---

## Measuring anything

Static costs you can read yourself: heap symbol counts and program size from the compiled `.asset`;
instruction counts from `.uasm` with `UDONSHARP_DEBUG`.

Dynamic costs need the tooling in [12](12-debugging-and-introspection.md):

- **`[DefaultExecutionOrder(±1e9)]` bracketing behaviours with `Stopwatch`es** measure *all* Udon in the world per phase, including `PostLateUpdate`, with zero cooperation from the code being measured.
- **`SerializationResult.byteCount`** is the one-line instrument that makes every sync-byte decision measurable.
- `System.Diagnostics.Stopwatch` works inside Udon (verified in shipped code; the whitelist itself lives in a binary and was not read directly). Cache `1/Frequency` once.

**Install UdonSharpOptimizer rather than hand-optimising what it already catches.** Its peepholes cover temp
coalescing, `__this` dedup, tail calls, jump-chain flattening and the scratch-then-copy pattern; source that
fights those is worse for no gain. Spend your own effort on the two things it cannot do: the boundary
crossings, and the choice of where data lives.
