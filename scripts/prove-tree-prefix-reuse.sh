#!/usr/bin/env bash
#
# Prove KV-cache prefix reuse across pi session-tree sibling branches, using
# direct Anthropic Messages API calls (no pi SDK).
#
# The pi session tree guarantees that two sibling branches (e.g. you edit an
# earlier turn) share a BYTE-IDENTICAL prefix. This script reproduces that at the
# wire level and proves the Anthropic API serves the shared prefix from cache
# (cache_read) while writing only the divergent tail (cache_creation).
#
# Model: claude-haiku-4-5 (minimum cacheable prefix = 4096 tokens). BOTH the
# system prompt S and the ancestor turn P are padded past that threshold so each
# caches as its own tier.
#
# pi places markers like this (pi-ai anthropic.js):
#   - system: cache_control on the system block            (the SYSTEM tier)
#   - messages: ONE cache_control on the last user turn     (the MESSAGE tier)
# Render order is system -> messages, so the message-tier entry covers system+P.
# In a branch request P carries NO marker; its boundary entry exists only because
# `prime` (where P is the last user turn) wrote it first -- exactly as an earlier
# conversation turn establishes that boundary in a real pi session.
#
# Requests ([*] = a cache_control marker; S = system, P = shared ancestor turn):
#   1. prime      sys=S[*]  msgs=[P[*]]            -> cold: creation ~= S+P, read 0
#   2. branch A   sys=S[*]  msgs=[P, ackA, qA[*]]  -> read ~= S+P, writes only the tail
#   3. branch B   sys=S[*]  msgs=[P, ackB, qB[*]]  -> read ~= S+P (SIBLING, different tail)
#   4. neg ctrl   sys=S[*]  msgs=[P2, ackB, qB[*]] -> read ~= S only (system tier SURVIVES,
#                                                     message tier busts: P2 mutates P)
#
# Req 3 is the headline: a sibling branch reuses the common prefix from cache.
# Req 4 proves the test can fail AND shows tiered invalidation: mutating the
# message region drops the message-tier read to the system tier alone.

set -euo pipefail

ENDPOINT="${PI_PROVE_ENDPOINT:-http://localhost:4000/v1/messages}"
MODEL="claude-haiku-4-5"
KEY="${LITELLM_PI_API_KEY:?set LITELLM_PI_API_KEY (see ~/.pi/agent/models.json)}"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
SFILE="$WORK/system.txt"
PFILE="$WORK/prefix.txt"
P2FILE="$WORK/prefix_mutated.txt"

# Per-run nonce at the very FRONT of the whole prefix (the system prompt), so
# every tier starts COLD. Without it, the previous run's entries -- still warm
# within the 5-min TTL -- would make `prime` itself a cache hit and contaminate
# the result.
RUN_ID="${PI_PROVE_RUN_ID:-$(date +%s)-$$-$RANDOM}"

# System prompt S (~5k tokens, > 4096 so it caches as its OWN tier). Nonce first.
{
    printf 'SYSTEM RUN %s\n' "$RUN_ID"
    for i in $(seq 1 260); do
        printf 'Policy %04d: be concise, cite sources, follow tool schemas, never fabricate output.\n' "$i"
    done
} > "$SFILE"

# Shared ancestor message turn P (~6.8k tokens), deterministic.
for i in $(seq 1 350); do
    printf 'Section %04d: the quick brown fox jumps over the lazy dog near the riverbank.\n' "$i"
done > "$PFILE"

# Negative-control ancestor: P with a mutated FIRST token, so divergence is at
# the start of the MESSAGE region. The system tier still matches and survives.
{ printf 'MUTATED-HEADER\n'; cat "$PFILE"; } > "$P2FILE"

STOK_EST=$(( $(wc -c < "$SFILE") / 4 ))
PTOK_EST=$(( $(wc -c < "$PFILE") / 4 ))
BAR="------------------------------------------------------------"
printf '%s\n  Tree prefix reuse proof  (system + message tiers)\n%s\n' "$BAR" "$BAR"
printf '  model      %s\n' "$MODEL"
printf '  endpoint   %s\n' "$ENDPOINT"
printf '  system S   ~%s tokens  (own cache tier, > 4096)\n' "$STOK_EST"
printf '  ancestor P ~%s tokens  (message tier, > 4096)\n' "$PTOK_EST"
printf '  run id     %s  (fresh prefix => cold cache)\n' "$RUN_ID"
printf '%s\n\n' "$BAR"
printf '  Each request is shaped as pi emits it: a cache_control marker [*] on the\n'
printf '  system block AND on the last user turn. Render order is system -> messages.\n\n'

# Build a request body. $1 = ancestor file, $2 = "prime" | "<ack>|<tail question>".
build_body() {
    local pfile="$1" mode="$2"
    if [[ "$mode" == "prime" ]]; then
        jq -n --rawfile s "$SFILE" --rawfile p "$pfile" '{
            model: $ENV.MODEL, max_tokens: 16,
            system: [{type:"text", text:$s, cache_control:{type:"ephemeral"}}],
            messages: [
                {role:"user", content:[{type:"text", text:$p, cache_control:{type:"ephemeral"}}]}
            ]
        }'
    else
        local ack="${mode%%|*}" q="${mode##*|}"
        # Faithful to pi: system block marked; ancestor P unmarked; the single
        # message-tier marker sits only on the last user turn.
        jq -n --rawfile s "$SFILE" --rawfile p "$pfile" --arg ack "$ack" --arg q "$q" '{
            model: $ENV.MODEL, max_tokens: 16,
            system: [{type:"text", text:$s, cache_control:{type:"ephemeral"}}],
            messages: [
                {role:"user", content:[{type:"text", text:$p}]},
                {role:"assistant", content:$ack},
                {role:"user", content:[{type:"text", text:$q, cache_control:{type:"ephemeral"}}]}
            ]
        }'
    fi
}

# Print the message shape of a request, send it, and print the usage outcome.
# Stashes read/creation per label for the verdict. $4 = one-line interpretation.
declare -A READ CREATE
send() {
    local label="$1" pfile="$2" mode="$3" note="$4"

    printf '  +-- %s %s\n' "$label" "${BAR:0:$((52 - ${#label}))}"
    printf '  | system     S  (~%s tok)                    [*]\n' "$STOK_EST"
    if [[ "$mode" == "prime" ]]; then
        printf '  | user       P  (~%s tok)                    [*]\n' "$PTOK_EST"
    else
        local ack="${mode%%|*}" q="${mode##*|}" plabel="P  (~${PTOK_EST} tok)"
        [[ "$pfile" == "$P2FILE" ]] && plabel="P2 (front token mutated)"
        printf '  | user       %s\n' "$plabel"
        printf '  | assistant  "%s"\n' "$ack"
        printf '  | user       "%s"   [*]\n' "$q"
    fi

    local resp
    resp=$(MODEL="$MODEL" build_body "$pfile" "$mode" | curl -s -X POST "$ENDPOINT" \
        -H "x-api-key: $KEY" -H "anthropic-version: 2023-06-01" \
        -H "content-type: application/json" --data-binary @-)

    local err
    err=$(jq -r '.error.message // empty' <<<"$resp")
    if [[ -n "$err" ]]; then
        printf '  | ERROR: %s\n' "$err"
        exit 1
    fi

    local read create
    read=$(jq -r '.usage.cache_read_input_tokens // 0' <<<"$resp")
    create=$(jq -r '.usage.cache_creation_input_tokens // 0' <<<"$resp")
    READ[$label]=$read
    CREATE[$label]=$create
    printf '  +-> read %6s  |  creation %6s   %s\n\n' "$read" "$create" "$note"
}

send "prime"    "$PFILE"  "prime" \
    "cold write of system + ancestor"
send "branchA"  "$PFILE"  "Acknowledged branch A.|Reply with the single word A." \
    "read system + ancestor, wrote only the tail"
send "branchB"  "$PFILE"  "Acknowledged branch B.|Reply with the single word B." \
    "SIBLING: same system + ancestor reused, different tail"
send "negctrl"  "$P2FILE" "Acknowledged branch B.|Reply with the single word B." \
    "system tier survives; message tier busts (P2 != P)"

# ---- Verdict --------------------------------------------------------------
pass=1
check() { # description, condition (0=true)
    if eval "$2"; then printf '  PASS  %s\n' "$1"; else printf '  FAIL  %s\n' "$1"; pass=0; fi
}

printf '%s\n  legend  [*] = a cache_control marker  (system block + last user turn)\n%s\n\n' "$BAR" "$BAR"

echo "Verdict:"
check "prime is cold (read==0) and writes system+ancestor (creation>0)" \
    "[[ ${CREATE[prime]} -gt 0 && ${READ[prime]} -eq 0 ]]"
check "branch A reads the whole written prefix (read ~= prime creation, within 5%)" \
    "awk -v a=${READ[branchA]} -v c=${CREATE[prime]} 'BEGIN{d=(a>c?a-c:c-a); exit !(c>0 && d/c<=0.05)}'"
check "branch B (sibling) matches branch A within 5%" \
    "awk -v a=${READ[branchA]} -v b=${READ[branchB]} 'BEGIN{d=(a>b?a-b:b-a); exit !(a>0 && d/a<=0.05)}'"
check "neg ctrl: SYSTEM tier survives the message-region change (read>0)" \
    "[[ ${READ[negctrl]} -gt 0 ]]"
check "neg ctrl: MESSAGE tier busts (read drops below branchA by >= ancestor size)" \
    "[[ $(( ${READ[branchA]} - ${READ[negctrl]} )) -ge 4000 ]]"
check "neg ctrl: message region rewritten (creation jumps by >= ancestor size)" \
    "[[ $(( ${CREATE[negctrl]} - ${CREATE[branchB]} )) -ge 4000 ]]"
echo

if [[ $pass -eq 1 ]]; then
    echo "RESULT: PROVEN -- sibling branches reuse the shared system+ancestor prefix from"
    echo "cache; a message-region change busts only the message tier, not the system tier."
else
    echo "RESULT: at least one check FAILED (see above)."
    exit 1
fi
