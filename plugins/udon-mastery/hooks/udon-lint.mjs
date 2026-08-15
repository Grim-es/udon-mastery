#!/usr/bin/env node
/**
 * udon-lint — PostToolUse guard for UdonSharp source.
 *
 * Flags C# constructs that compile fine in an IDE and then fail (or silently
 * misbehave) under Udon. Every rule here is mechanical; judgement calls belong
 * in the skill, not in this file.
 *
 * Contract: reads the PostToolUse JSON on stdin, exits 2 with findings on
 * stderr so Claude sees them. Exits 0 — silently — on anything it cannot
 * confidently analyse. A linter that cries wolf gets switched off.
 */

import { readFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';

// ── Rules ───────────────────────────────────────────────────────────────────
// `re` runs against a line with comments and string literals already stripped.

const RULES = [
  { re: /\busing\s+System\.Linq\b/,                    msg: 'LINQ is not exposed to Udon',                        fix: 'manual for/foreach' },
  { re: /\busing\s+System\.Collections\.Generic\b/,     msg: 'System.Collections.Generic is not exposed to Udon',  fix: 'arrays T[], or DataList/DataDictionary (VRC.SDK3.Data)' },
  { re: /\b(?:List|Dictionary|HashSet|Queue|Stack|IEnumerable|KeyValuePair)\s*</, msg: 'generic collection is not exposed to Udon', fix: 'arrays T[], or DataList/DataDictionary' },
  { re: /\b(?:try|catch|finally)\s*[({]|\bthrow\s+new\b/, msg: 'Udon has no exceptions',                          fix: 'guard with if + Utilities.IsValid(); return a sentinel' },
  { re: /\bIEnumerator\b|\byield\s+(?:return|break)\b|\bStartCoroutine\b/, msg: 'no coroutines in Udon',           fix: 'SendCustomEventDelayedSeconds(nameof(M), t) / ...DelayedFrames' },
  { re: /\basync\s+\w|\bawait\s+\w|\bTask\s*</,        msg: 'no async/await in Udon',                             fix: 'SendCustomEventDelayedFrames(nameof(M), n)' },
  { re: /\b[A-Za-z_][\w.]*\s*\[\s*,|new\s+[A-Za-z_][\w.]*\s*\[[^\]]*,[^\]]*\]/, msg: 'multidimensional array', fix: 'jagged T[][], or flat T[] with index math (r*cols+c)' },
  { re: /^\s*(?:(?:public|private|protected|internal|partial)\s+)*interface\s+\w/, msg: 'interfaces cannot be declared or implemented', fix: 'abstract UdonSharpBehaviour base + virtual methods' },
  { re: /^\s*(?:(?:public|private|protected|internal|readonly|partial)\s+)*struct\s+\w/, msg: 'user-declared struct', fix: 'plain class, or parallel arrays' },
  { re: /\b(?:Action|Func|Predicate|Comparison)\b|\bdelegate\b|^\s*(?:public|private|protected|internal)?\s*event\s/, msg: 'no delegates / lambdas / events', fix: 'SendCustomEvent(nameof(M)) / SendCustomNetworkEvent(target, nameof(M))' },
  { re: /\b(?:int|uint|long|ulong|short|byte|sbyte|float|double|bool|char|decimal|Vector2|Vector3|Vector4|Quaternion|Color)\?(?!\?)/, msg: 'nullable value type', fix: 'a sentinel (-1, float.PositiveInfinity) that is already correct for its consumer' },
  { re: /\bnew\s+[A-Z][\w.]*\s*(?:\([^)]*\))?\s*\{/, msg: 'object/collection initializer',                        fix: 'construct, then assign fields (array initialisers new[]{…} are fine)' },
  { re: /\bswitch\s*\{|\)\s*switch\s*$/,              msg: 'switch expression',                                   fix: 'switch statement (it compiles to a jump table)' },
  { re: /\bpartial\s+(?:void|[A-Za-z_][\w.<>]*)\s+\w+\s*\([^)]*\)\s*;/, msg: 'partial method (partial *class* is fine)', fix: 'declare the method normally' },
  // Static *methods* are legal, `const` is legal, `static readonly` is not.
  // Too many shapes for one regex, so decide in code: a static, non-const
  // declaration whose left-hand side is "…Type name" with no parameter list.
  { test: line => {
      if (!/^\s*(?:(?:public|private|protected|internal|new)\s+)*static\b/.test(line)) return false;
      if (/\bconst\b/.test(line)) return false;
      const decl = line.split(/[=;]/)[0];
      return !decl.includes('(') && /\w\s+\w+\s*$/.test(decl);
    },
    msg: 'static mutable field (static *methods* are fine; static readonly is also rejected)',
    fix: 'const, or an instance field on a shared singleton behaviour' },
  { re: /\.material\b/,                                msg: '.material clones the material — leaks permanently in a world that never unloads', fix: 'sharedMaterial(s) or a MaterialPropertyBlock (GetPropertyBlock before SetPropertyBlock)' },
];

// ── Preprocessor handling ───────────────────────────────────────────────────
// A line is exempt when it sits inside a region the Udon pass never compiles,
// i.e. any enclosing condition containing `!COMPILER_UDONSHARP`.

const EDITOR_ONLY = /!\s*COMPILER_UDONSHARP/;

function analyse(source) {
  const findings = [];
  const stack = [];                       // one bool per open #if: "excluded from Udon"
  let inBlockComment = false;

  source.split(/\r?\n/).forEach((raw, i) => {
    const lineNo = i + 1;
    const directive = raw.match(/^\s*#\s*(if|elif|else|endif)\b(.*)$/);

    if (directive) {
      const [, kind, cond] = directive;
      if (kind === 'if')          stack.push(EDITOR_ONLY.test(cond));
      else if (kind === 'elif')   stack[stack.length - 1] = EDITOR_ONLY.test(cond);
      else if (kind === 'else')   stack[stack.length - 1] = !stack[stack.length - 1];
      else                        stack.pop();

      if ((kind === 'if' || kind === 'elif') && /\bUNITY_EDITOR\b/.test(cond) && !/COMPILER_UDONSHARP/.test(cond)) {
        findings.push({ lineNo, text: raw.trim(),
          msg: '#if UNITY_EDITOR does not hide code from Udon — U# compiles inside the editor',
          fix: '#if UNITY_EDITOR && !COMPILER_UDONSHARP' });
      }
      return;
    }

    if (stack.some(Boolean)) return;      // editor-only region: full C# is legal here

    // Strip block comments, line comments, then string/char literals.
    let line = raw;
    if (inBlockComment) {
      const end = line.indexOf('*/');
      if (end === -1) return;
      line = line.slice(end + 2);
      inBlockComment = false;
    }
    line = line.replace(/\/\*.*?\*\//g, ' ');
    const open = line.indexOf('/*');
    if (open !== -1) { inBlockComment = true; line = line.slice(0, open); }
    line = line.replace(/\/\/.*$/, ' ')
               .replace(/@"(?:[^"]|"")*"/g, '""')
               .replace(/"(?:\\.|[^"\\])*"/g, '""')
               .replace(/'(?:\\.|[^'\\])'/g, "''");

    if (!line.trim()) return;

    for (const rule of RULES) {
      if (rule.re ? rule.re.test(line) : rule.test(line)) {
        findings.push({ lineNo, text: raw.trim(), msg: rule.msg, fix: rule.fix });
        break;                            // one finding per line keeps output readable
      }
    }
  });

  return findings;
}

// ── Underscore sent over the network (always on) ────────────────────────────
// The receiving client refuses any legacy network event whose name starts with
// `_`, so this call silently does nothing in a build while working fine in a
// local test. It is the exact failure mode of "underscore everything, then
// forget to un-underscore the one method that had to be networked".

function underscoreNetworkCalls(source) {
  const out = [];
  source.split(/\r?\n/).forEach((raw, i) => {
    const m = raw.match(/SendCustomNetworkEvent\s*\([^,)]*,\s*(?:nameof\s*\(\s*(_\w+)\s*\)|"(_\w+)")/);
    if (!m) return;
    const name = m[1] || m[2];
    // `[NetworkCallable]` deliberately overrides the underscore rule.
    const decl = new RegExp(`\\[\\s*NetworkCallable[^\\]]*\\][\\s\\S]{0,200}?\\b${name}\\s*\\(`);
    if (decl.test(source)) return;
    out.push({ lineNo: i + 1, name, text: raw.trim() });
  });
  return out;
}

// ── Remote surface (on by default) ──────────────────────────────────────────
// Any public method that is not `_`-prefixed and not a built-in Udon event can
// be invoked by name by any player in the instance using a modified client.
// Sometimes that is deliberate — so it can be acknowledged in place with a
// `// udon-lint: network-entry` marker, which lets a maintained file converge
// to silence. Set UDON_LINT_REMOTE=0 to switch the check off entirely.

const UDON_EVENTS = new Set(`Start Update LateUpdate FixedUpdate PostLateUpdate Interact
OnPlayerJoined OnPlayerLeft OnDeserialization OnPreSerialization OnPostSerialization
OnOwnershipTransferred OnOwnershipRequest OnPickup OnDrop OnPickupUseDown OnPickupUseUp
OnPlayerTriggerEnter OnPlayerTriggerExit OnPlayerTriggerStay OnTriggerEnter OnTriggerExit
OnTriggerStay OnCollisionEnter OnCollisionExit OnCollisionStay OnPlayerCollisionEnter
OnPlayerCollisionExit OnPlayerCollisionStay OnStationEntered OnStationExited OnSpawn
OnPlayerRespawn OnAvatarChanged OnAvatarEyeHeightChanged OnLanguageChanged OnMasterTransferred
OnPlayerRestored OnEnable OnDisable OnDestroy OnPreRender OnPostRender OnRenderObject
OnWillRenderObject OnAnimatorIK OnAnimatorMove OnParticleCollision OnPlayerParticleCollision
OnVideoStart OnVideoEnd OnVideoError OnVideoLoop OnVideoPause OnVideoPlay OnVideoReady
OnInputUse OnInputJump OnInputGrab OnInputDrop OnInputMoveHorizontal OnInputMoveVertical
OnInputLookHorizontal OnInputLookVertical OnScreenUpdate OnPlayerTriggerEnterCollider`.split(/\s+/));

const ACK = /udon-lint:\s*network-entry/;

function remoteSurface(source) {
  if (process.env.UDON_LINT_REMOTE === '0') return [];
  // A `None`-sync behaviour refuses network events outright.
  if (/BehaviourSyncMode\.None/.test(source)) return [];

  const lines = source.split(/\r?\n/);
  const out = [];
  lines.forEach((line, i) => {
    const m = line.match(/^\s*public\s+void\s+([A-Za-z]\w*)\s*\(/);
    if (!m || UDON_EVENTS.has(m[1])) return;
    const prevRaw = i > 0 ? lines[i - 1] : '';
    // The attribute must be code. A comment that merely mentions it does not count.
    const prevCode = prevRaw.replace(/\/\/.*$/, '');
    if (/\[\s*NetworkCallable\b/.test(prevCode)) return;   // deliberate modern endpoint
    if (ACK.test(line) || ACK.test(prevRaw)) return;       // acknowledged legacy endpoint
    out.push(m[1]);
  });
  return out;
}

// ── Entry point ─────────────────────────────────────────────────────────────

function main() {
  let payload;
  try {
    payload = JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    return 0;                             // not our business
  }

  const filePath = payload?.tool_input?.file_path;
  if (typeof filePath !== 'string' || !filePath.endsWith('.cs')) return 0;

  const abs = resolve(payload.cwd || '.', filePath);
  const parts = abs.split(/[\\/]/);
  // Editor-only assemblies are unrestricted C# by definition.
  if (parts.includes('Editor')) return 0;

  let source;
  try {
    source = readFileSync(abs, 'utf8');
  } catch {
    return 0;
  }

  // Only lint actual Udon programs — not the plain C# that shares the folder.
  if (!/\bUdonSharpBehaviour\b/.test(source)) return 0;

  const findings = analyse(source);
  const missingSyncMode =
    /class\s+\w+\s*:\s*UdonSharpBehaviour\b/.test(source) &&
    !/\[\s*UdonBehaviourSyncMode\b/.test(source) &&
    !/\bpartial\s+class\b/.test(source);
  const exposed = remoteSurface(source);

  // A network event aimed at a `_` method never fires — promote it to a finding.
  for (const c of underscoreNetworkCalls(source)) {
    findings.push({
      lineNo: c.lineNo, text: c.text,
      msg: `network event targets '${c.name}' — the receiving client refuses names starting with _, so this silently does nothing`,
      fix: `drop the underscore (and treat it as an untrusted entry point), or mark ${c.name} [NetworkCallable]`,
    });
  }
  findings.sort((a, b) => a.lineNo - b.lineNo);

  if (!findings.length && !missingSyncMode && !exposed.length) return 0;

  const rel = abs.split(sep).slice(-3).join('/');
  const lines = [`UdonSharp lint — ${rel}`, ''];
  for (const f of findings) {
    lines.push(`  L${f.lineNo}: ${f.msg}`);
    lines.push(`         ${f.text.length > 100 ? f.text.slice(0, 97) + '...' : f.text}`);
    lines.push(`         → ${f.fix}`);
  }
  if (missingSyncMode) {
    lines.push('  no [UdonBehaviourSyncMode(...)] on the class');
    lines.push('         → declare it explicitly; the default leaves SendCustomNetworkEvent behaviour implicit');
  }
  if (exposed.length) {
    lines.push(`  remotely callable by any player (${exposed.length}): ${exposed.join(', ')}`);
    lines.push('         → prefix with _ if it is not meant to be a network entry point.');
    lines.push('           If it is meant to be, validate its arguments, re-derive authority from');
    lines.push('           synced state, and mark it: // udon-lint: network-entry');
  }
  lines.push('', 'These fail the U# compile or misbehave at runtime — they do not fail in the IDE.');
  lines.push('Read the udon-mastery:udonsharp skill for the full constraint table and workarounds.');

  process.stderr.write(lines.join('\n') + '\n');
  return 2;
}

process.exit(main());
