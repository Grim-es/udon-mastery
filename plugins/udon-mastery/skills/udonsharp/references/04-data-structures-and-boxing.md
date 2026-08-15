# 04 — Data structures & boxing

No `List<T>`, no `Dictionary<,>`, no structs, no tuples, no nullable value types, no multidimensional
arrays. Here is what to use instead. Note the default is **not** `DataList`/`DataDictionary`: reach for
them only when the shape is genuinely dynamic and heterogeneous.

---

## Contents

- [1. Parallel arrays indexed by an integer are the struct](#1-parallel-arrays-indexed-by-an-integer-are-the-struct)
- [2. Sentinels](#2-sentinels)
- [3. Index hints and self-validating caches](#3-index-hints-and-self-validating-caches)
- [4. Reaching the BCL sideways](#4-reaching-the-bcl-sideways)
- [5. Jagged, flat and strided](#5-jagged-flat-and-strided)
- [6. `object[]` and erasure](#6-object-and-erasure)
- [7. `DataList` / `DataDictionary` — when, and when not](#7-datalist--datadictionary--when-and-when-not)
- [8. Packing](#8-packing)
- [9. Structures Unity already maintains for you](#9-structures-unity-already-maintains-for-you)

---

## 1. Parallel arrays indexed by an integer are the struct

The near-universal default. One logical record is spread across N arrays and addressed by a shared index;
the index is the handle, and Udon has no structs to make a handle type out of anyway.

```csharp
private Collider[] emitters      = new Collider[0];
private float[]    cachedLengths = new float[0];   // the "struct" field
private float[]    cachedWidths  = new float[0];
```

Two allocation policies, and the choice between them is the whole design. **Pick by whether an index must
stay valid across a removal.**

**If the maximum is known and small, stop here:** allocate the arrays at full size once, let the index *be*
the handle, and carry a separate `bool[] occupied`. No allocator, no growth policy. The two policies below
are for genuinely unbounded churn.

### Slot-stable free list — grow to high water, null out to free, **never compact**

This must live in a **plain static class, not on a `UdonSharpBehaviour`**: generic methods on a behaviour
are a hard compile error (`CE_UdonSharpBehaviourGenericMethodsNotSupported`), while generic statics in a
non-behaviour class monomorphise per call site and work.

```csharp
public static class Slots {
    public static int Add<T>(ref T[] list, T item) {
        for (var i = 0; i < list.Length; i++) if (Equals(list[i], item)) return i;         // idempotent add
        for (var i = 0; i < list.Length; i++)                                              // reuse a hole
            if (Equals(list[i], default(T))) { list[i] = item; return i; }
        var grown = new T[list.Length + 1];                                                // grow by ONE
        Array.Copy(list, grown, list.Length);
        grown[list.Length] = item;
        list = grown;
        return list.Length - 1;
    }
}
```

Use `Equals(a, b)` (the static `object.Equals`), not `==`: an unconstrained `T` has no `==`, and
`EqualityComparer<T>` drags in `System.Collections.Generic`. **Grow every parallel array in the same call**
or they desync (see Tombstones below).

**Deliberately leaking the hole is what buys the stable handle**, which is what makes the parallel arrays
safe: swap-remove would silently re-associate a cached length with the wrong record. The array converges
to high-water occupancy and then allocates **zero forever** under unbounded churn. Grow by `+1`, not by
doubling, because the high-water mark is small and the linear hole-scan would have to walk the waste.
Holes must be `default(T)`-detectable, so a `T` whose legitimate value can be `default` needs a separate
occupancy array.

### Swap-with-last compacting pool — one `int` is the whole allocator

```csharp
private void Deallocate(int index) {
    var last = --indexEnd;
    if (index == last) return;
    durations[index] = durations[last];
    var t = renderers[index]; renderers[index] = renderers[last]; renderers[last] = t;
    // …repeat for EVERY parallel array
}
```

O(1) allocate with no search, O(1) free, and the live set is always the dense prefix `[0, indexEnd)` so the
per-frame loop only touches live entries. **The `while` loop must not `i++` after a removal**: the swap
moved an unexamined element into `i`, and writing it as a `for` silently skips every second expiring item.
Ordering is not preserved, so this is wrong wherever draw order or index stability matters. The recurring
bug is a parallel array left out of the swap; audit the deallocator against the field list every time you
add an array.

### Tombstones

The third shape, for arrays that are also the wire format: tri-state tombstones (`-1` empty / `0` orphaned
/ `>0` id) with an explicit logical length, so **compaction and serialization become the same operation**.
Same audit obligation, sharper consequence: a parallel array not grown alongside the others desyncs
clients, and the symptom appears nowhere near the allocator.

---

## 2. Sentinels

There are no nullable value types, so every "absent" is a sentinel. **Choose a sentinel that is already
correct under the relation that consumes it.** That deletes a guard instead of adding one:

- `int.MaxValue` as "unregistered" sorts *last* under the same ascending comparison used for real orders: no `if (order < 0)` in the comparator.
- `float.PositiveInfinity` as "nothing in range" makes naive consumer code `if (dist < threshold)` correct by default, where `0` would invert it into a false positive.
- `0xFFFE` rather than `-1` for "no entry", deliberately distinct from `IndexOf`'s `-1` *and* from any legal index.
- `-1` doubling as both "unregistered" and "no active sender".
- `float.Epsilon` as an in-band sentinel in a value channel.
- **The `+1` bias is what makes zero signable.** Partition a float's value space into {absent = 0, payload = ±(id+1), command codes} and you get a nullable, a mode bit and an ID in one lane.

---

## 3. Index hints and self-validating caches

There is no `Dictionary<Object,int>`, so lookups are linear scans, but a scan you almost never run is
free:

```csharp
int hint = instance.RegistryOrder;                                  // a field that exists for another purpose
if (hint >= 0 && hint < count && registry[hint] == instance) return hint;
return Array.IndexOf((Array)registry, instance, 0, count);          // fallback
```

**A self-validating cache with no invalidation protocol at all**: a stale hint is free to detect and costs
only the fallback it would have paid anyway. The obvious alternative (a parallel `int[] indexOf` kept in
sync) needs invalidating at every site that mutates the registry, which is where the bugs live.

The same shape solves a different problem: **memoise by instance ID *and* the object**, because Unity
recycles instance IDs after a scene unload and a bare int-keyed set would silently suppress work for an
unrelated component in a later scene. Store the object as the *value* and check `ReferenceEquals`: the ID
becomes a hint validated by reference identity.

And the invariant-by-construction version: **`transform.GetSiblingIndex()` as an element's own index into
its owner's parallel arrays**: impossible to violate by forgetting to update it.

---

## 4. Reaching the BCL sideways

- **`Array.IndexOf` via a `(Array)` upcast.** `Array.IndexOf<T>(T[], T)` is generic and unavailable; `Array.IndexOf(Array, object, int, int)` is not, and *is* exposed. One EXTERN replacing an interpreted loop, and one fewer duplicated body per element type. **General lesson: look for a pre-generics non-generic overload.** Caveat: `object` equality is reference equality for `UnityEngine.Object`, so it cannot see Unity's fake-nulls.
- **`object.Equals(a, b)` is the constraint escape for generic helpers.** `==` fails on an unconstrained `T`, and `EqualityComparer<T>.Default` drags in `System.Collections.Generic`. The correct escape is the oldest and least fashionable one.
- **`Buffer.BlockCopy` reinterprets `float[]` as `byte[]`** in one EXTERN with no loop.
- **`Array.Copy` is one EXTERN** where the equivalent loop is N interpreted iterations.
- **`string.Concat(string[])` is the `StringBuilder` substitute** on the hot path, though `StringBuilder` itself does compile.
- **`Enum.TryParse` on a *field name*** collapses dozens of named inspector bools into a dense runtime `int[]`.
- **`System.Type` is a first-class runtime value**: serializable on a behaviour, usable as `Type[]` for a dispatch table, testable with `GetType() == typeof(UnityType)`. `switch` on `Type` is impossible; `switch` on `Type.Name` (a string constant) works.

---

## 5. Jagged, flat and strided

- **Jagged `T[][]` is the sanctioned `T[,]` substitute.** Multidimensional arrays are rejected *at creation* (the element-access check in the binder is commented out, but you cannot make one).
- **Flat array + stride is usually better than jagged**: one heap object instead of N, and no extra indirection per access. `float[renderers * maxScreens]` with `Array.Copy` into a reused `float[maxScreens]` scratch is the pattern, and because `SetFloatArray` copies its input, **one scratch allocation serves N consumers**.
- **Count-then-fill** builds an exactly-sized flat array without a `List<T>`: a jagged `T[][]` holds each group's `GetComponentsInChildren` result while a running count accumulates, then the flat arrays are allocated at the exact final size and filled in a second pass. Save the *prior* state alongside, so your mask composes with other systems doing the same thing, and restore **backwards** so nested roots unwind in application order.
- **Two logical lists in one fixed buffer, partitioned by an uploaded boundary scalar.** N sets need N−1 boundary scalars. Build it with **two filtered passes** over the index list rather than a sort: no comparator (there are no delegates), no swaps, no second buffer.
- **Bounded top-K insertion select instead of sorting**: walk once, insert into a fixed `int[32]` of *indices*, never permute the authoring array (so inspector order stays stable and visible), and start the shift loop at `MaxCount-1` when full so the loser falls off the end. Degenerates to O(n) when most candidates lose.
- **Sort the *permutation*, not the data.** An `int[]` view plus a `filteredView` count plus a `bool[] hidden` aligned to raw indices means sorting never invalidates the filter, and an interrupted time-sliced sort leaves valid-but-unsorted data.

---

## 6. `object[]` and erasure

When a record genuinely must be heterogeneous:

- **`object[]`-as-struct with the field name in a comment at every index**: the honest Udon-legal downgrade of an OO design, annotated line by line. The XML comment is the schema.
- **`object` field + an `abstract Type FieldType` property** is the erasure substitute for `Field<T>`; `Try…` + `bool` is the exception-free downcast.
- **A char-prefixed string as a struct substitute at the *serialization* boundary** (`"0 _Color"`), because an abstract-base array *is* serializable and a struct is not.
- **`out` parameters as the tuple substitute.** Re-entrant and free; the reflexive `_outA`/`_outB` field pair is neither. Illegal on `[NetworkCallable]`.
- **`int[]` return as a tuple, on cold paths only.** It costs a heap allocation per call, so hand-inline the arithmetic on hot paths. The selective use *is* the technique.
- **Undo/redo as an `object[][]` ring buffer** with an int discriminator instead of a stored callback.

---

## 7. `DataList` / `DataDictionary` — when, and when not

They exist and they box. Reach for them when the shape is genuinely dynamic and heterogeneous; avoid them
on hot paths keyed by object identity, where a `DataToken` box plus a hash EXTERN loses to a linear scan
over a single-digit array.

When you do use them:

- **`DataToken` will not key on a `UnityEngine.Object`.** `GetInstanceID()` is the legal stand-in. Store *indices* into a fixed array rather than the objects, so eviction is cheap: a modulo ring pointer picks the victim and the victim's key is recoverable *from the victim itself*, needing no reverse-index array.
- **The key-type trap**: added with a string key, removed with an int key. It never matches and never errors. Easy to write and silent at runtime; pin the key type at the declaration and never widen it.
- **`TryGetValue(key, TokenType.X, out t)`** is the exception-free downcast, and the *only* safe access. The bracket indexer **halts the behaviour** on a missing key or wrong type, with nothing to catch. Use brackets only where you own the data and can guarantee key and type.
- **Prebuild a template and `ShallowClone()`**: six `Add` EXTERNs become two indexer writes, and a `readonly` field initialiser can run the whole builder chain. **But field initialisers are evaluated at compile time**: they cannot reference scene objects or anything resolved at runtime. Anything scene-dependent belongs in `Start()`.
- **Never build a `DataToken` from `nameof()`**: implicit conversion from it misbehaves under U#. Assign to a `string` local first.
- **`[OdinSerialize]`** (`VRC.Udon.Serialization.OdinSerializer`) persists `DataList`/`DataDictionary` where Unity cannot, with one exception: **object-reference tokens cannot be serialized at all**. Keep references out of anything you intend to persist.
- **`DeepClone` does not descend into arrays.** An array inside a token graph stays shared after the clone; copy it yourself.
- **A free list as a sparse set**: `DataList` + `DataDictionary` derived *locally* from one synced bool per object gives O(1) random pick and O(1) remove with zero sync bytes and idempotent membership guards.
- **Categorised dedup instead of a hash map**: fill per-category arrays by scan-and-append with *local* indices, then convert local → global in a second pass by adding category offsets once the counts are final. Categories stay independently appendable while producing one dense contiguous ID space, with no second data structure and no hashing.
- **Parallel `_key`/`_val` arrays** are the serializable dictionary: `Dictionary<,>` neither serializes in Unity *nor* exists in Udon. The `_key`/`_val` suffix convention documents the coupling at every use site.

---

## 8. Packing

Covered in depth for the GPU in [09](09-udon-gpu-bridges.md) and for the wire in
[06](06-network-event-dispatch.md); the shared rules:

- **Choose a radix that stays exactly representable.** `x + y*256 + code*65536` is deliberately below 2²⁴ so a float32 mantissa holds it exactly and `floor`/`fmod` unpack with no rounding slop.
- **Stack sentinel + sign + integer + fraction in one float**: `10000` = disabled (a magnitude no real ID reaches), `0` = on-but-none, `±(id+1)` where the sign is a mode bit and the `+1` makes zero signable, plus a fractional fade added *away from zero* so `abs(floor())` and `frac()` both recover cleanly.
- **Bit-reinterpret rather than store-as-float.** `BitConverter.SingleToInt32Bits`/`Int32BitsToSingle` are exposed; storing an integer *as* a float wastes a whole lane and loses precision above 2²⁴.
- **Pack orthogonal bitfields into one synced `int`** and atomicity becomes *structural*: no callback-ordering question, no "am I mid-transmit" flag anywhere.
- **Base64 of raw floats inside a `VRCJson` envelope** for user-facing persistence. Note that **VRCJson serializes string keys only**, so a dictionary you intend to emit must be string-keyed from the start: `Buffer.BlockCopy` + `Convert.ToBase64String` gives 5.33 bytes per float with an exact bit-for-bit round trip and **zero loops**, versus `float.ToString("R")` joined with `+=`, which in Udon is O(n²) in copied bytes.
- **Content-addressed dedup must be opt-out for anything mutable**, and the opt-out has to be a parallel flag array carried alongside the data rather than a property of the content, otherwise every constant-filled reserved slot collapses into one.

---

## 9. Structures Unity already maintains for you

The cheapest data structure is one the engine keeps up to date without your help:

- **The Transform child list is a ring buffer.** `GetChild(0)` + `SetAsLastSibling()` does dequeue, enqueue and re-sort in one call; `childCount` is the live count.
- **`GetSiblingIndex()` recovers display order** for a slot pool, so an ordered collection is offloaded onto Unity entirely.
- **`GameObject.name` as an out-of-band metadata column** for behaviour-less rows: type-first so a `StartsWith` fast path exists. And child GameObject names (`d:25`, `t:3`) as a payload channel that is authorable by non-programmers and survives `OnParticleCollision`, where nothing else does.
- **`Renderer.sortingOrder`** (a serialized field with no inspector UI) as a stable per-object index.
- **A `ParticleSystem` is already a pool**: its ring is the allocator, particle lifetime is the duration, and its renderer batches.
- **A 1×1 texture as a pure identity token**, when a system keys on object identity and you have nothing to give it: mint a cheap object rather than threading a "virtual source" flag through the whole pipeline.
