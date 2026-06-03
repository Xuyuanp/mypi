#!/usr/bin/env bash
#
# Prove per-turn KV-cache reuse when navigating BACK across a multi-turn
# conversation in a pi session tree, using direct Anthropic Messages API calls
# (no pi SDK).
#
# Real pi conversations mark each turn as it becomes the tail (pi-ai places ONE
# message-tier cache_control marker on the last user turn). Replaying turns 1..N
# therefore leaves a cache entry at EACH turn boundary @u1, @u2, ..., @uN.
#
# When you navigate back and edit turn K (creating a sibling branch), the new
# request reuses the cache up to the last marked boundary BEFORE the edit -- the
# @u(K-1) boundary -- which is exactly what the ORIGINAL turn-K request reused.
# So: edit_K.read ~= req_K.read, and reuse grows the later you branch.
#
# Model: claude-haiku-4-5 (min cacheable prefix = 4096 tokens). The system prompt
# and turn 1 are padded past that so the early boundaries cache; later turns add
# smaller increments, each still above the cumulative minimum.
#
# Phase 1 (replay):  req1 [u1*] ; req2 [u1,a1,u2*] ; req3 [..,u3*] ; req4 [..,u4*]
# Phase 2 (navigate back): editK = same prefix but the turn-K user text changed,
#   marker on that edited turn. Expect editK.read ~= reqK.read.
#
# [*] = the single message-tier marker (last user turn). system block also marked.

set -euo pipefail

ENDPOINT="${PI_PROVE_ENDPOINT:-http://localhost:4000/v1/messages}"
MODEL="claude-haiku-4-5"; export MODEL
KEY="${LITELLM_PI_API_KEY:?set LITELLM_PI_API_KEY (see ~/.pi/agent/models.json)}"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
SFILE="$WORK/system.txt"
U1="$WORK/u1.txt"; U2="$WORK/u2.txt"; U3="$WORK/u3.txt"; U4="$WORK/u4.txt"

# Per-run nonce at the very front of the whole prefix (system) => every tier cold.
RUN_ID="${PI_PROVE_RUN_ID:-$(date +%s)-$$-$RANDOM}"

gen() { # file, turn-tag, line-count
    local f="$1" tag="$2" n="$3" i
    : > "$f"
    for ((i = 1; i <= n; i++)); do
        printf '%s line %04d: lorem ipsum dolor sit amet consectetur adipiscing elit.\n' "$tag" "$i" >> "$f"
    done
}

{ printf 'SYSTEM RUN %s\n' "$RUN_ID"; gen /dev/stdout "Policy" 260; } > "$SFILE"
gen "$U1" "Turn1" 240   # ~4.5k tokens (clears the 4096 minimum on its own)
gen "$U2" "Turn2" 110   # ~2k tokens
gen "$U3" "Turn3" 110
gen "$U4" "Turn4" 110

tok() { echo $(( $(wc -c < "$1") / 4 )); }
STOK=$(tok "$SFILE"); declare -A TT
TT[1]=$(tok "$U1"); TT[2]=$(tok "$U2"); TT[3]=$(tok "$U3"); TT[4]=$(tok "$U4")

US=$(jq -n --rawfile u1 "$U1" --rawfile u2 "$U2" --rawfile u3 "$U3" --rawfile u4 "$U4" \
    '[$u1,$u2,$u3,$u4]')
AS='["Acknowledged turn 1.","Acknowledged turn 2.","Acknowledged turn 3.","Acknowledged turn 4."]'

BAR="------------------------------------------------------------"
printf '%s\n  Navigate-back reuse proof  (multi user/assistant turns)\n%s\n' "$BAR" "$BAR"
printf '  model      %s\n' "$MODEL"
printf '  endpoint   %s\n' "$ENDPOINT"
printf '  system S   ~%s tok   turns ~%s/%s/%s/%s tok\n' "$STOK" "${TT[1]}" "${TT[2]}" "${TT[3]}" "${TT[4]}"
printf '  run id     %s  (fresh prefix => cold cache)\n' "$RUN_ID"
printf '%s\n\n' "$BAR"

# Build a request body asking turn $1; $2 = override text for that turn (empty =
# original). Complete turns 1..k-1 are user+assistant; the pending turn k is a
# lone marked user turn. The system block is marked too.
build_body() { # k, override
    local k="$1" last="${2:-}" useLast=0
    [[ -n "$last" ]] && useLast=1
    jq -n --rawfile s "$SFILE" --argjson us "$US" --argjson as "$AS" \
        --arg k "$k" --arg last "$last" --arg useLast "$useLast" '
        {
            model: $ENV.MODEL, max_tokens: 16,
            system: [{type:"text", text:$s, cache_control:{type:"ephemeral"}}],
            messages: (($k|tonumber) as $k | [ range(0;$k) as $i |
                ( if ($i == $k - 1)
                  then { role:"user", content:[{ type:"text",
                          text:(if $useLast=="1" then $last else $us[$i] end),
                          cache_control:{type:"ephemeral"} }] }
                  else ( {role:"user", content:[{type:"text", text:$us[$i]}]},
                         {role:"assistant", content:$as[$i]} )
                  end ) ])
        }'
}

declare -A READ CREATE
send() { # label, k, override, note
    local label="$1" k="$2" override="$3" note="$4"
    local edited=0; [[ -n "$override" ]] && edited=1

    printf '  +-- %s %s\n' "$label" "${BAR:0:$((52 - ${#label}))}"
    printf '  | system     S  (~%s tok)                       [*]\n' "$STOK"
    if (( k > 1 )); then
        printf '  | turns 1..%d  (u/a pairs, shared prefix)\n' "$((k - 1))"
    fi
    if (( edited )); then
        printf '  | user       u%d (EDITED)                          [*]\n' "$k"
    else
        printf '  | user       u%d (~%s tok)                       [*]\n' "$k" "${TT[$k]}"
    fi

    local resp
    resp=$(build_body "$k" "$override" | curl -s -X POST "$ENDPOINT" \
        -H "x-api-key: $KEY" -H "anthropic-version: 2023-06-01" \
        -H "content-type: application/json" --data-binary @-)
    local err; err=$(jq -r '.error.message // empty' <<<"$resp")
    if [[ -n "$err" ]]; then printf '  | ERROR: %s\n' "$err"; exit 1; fi

    READ[$label]=$(jq -r '.usage.cache_read_input_tokens // 0' <<<"$resp")
    CREATE[$label]=$(jq -r '.usage.cache_creation_input_tokens // 0' <<<"$resp")
    printf '  +-> read %6s  |  creation %6s   %s\n\n' "${READ[$label]}" "${CREATE[$label]}" "$note"
}

echo "Phase 1 -- replay the conversation (each request marks the latest turn):"
echo
send "req1" 1 "" "cold: writes system + turn 1"
send "req2" 2 "" "reads @turn1 boundary"
send "req3" 3 "" "reads @turn2 boundary"
send "req4" 4 "" "reads @turn3 boundary"

echo "Phase 2 -- navigate back and re-ask an earlier turn (sibling branch):"
echo
send "edit2" 2 "EDITED turn 2: reconsider differently." "should reuse the same boundary as req2"
send "edit3" 3 "EDITED turn 3: reconsider differently." "should reuse the same boundary as req3"
send "edit4" 4 "EDITED turn 4: reconsider differently." "should reuse the same boundary as req4"

# ---- Side-by-side summary -------------------------------------------------
printf '%s\n  reuse by branch depth (read tokens)\n%s\n' "$BAR" "$BAR"
printf '  %-8s %-12s %-16s %s\n' "edit @" "ask (reqK)" "navigate (editK)" "reused up to"
for k in 2 3 4; do
    printf '  turn %-3s %-12s %-16s turn %d boundary\n' \
        "$k" "${READ[req$k]}" "${READ[edit$k]}" "$((k - 1))"
done
printf '%s\n\n' "$BAR"

# ---- Verdict --------------------------------------------------------------
pass=1
check() { if eval "$2"; then printf '  PASS  %s\n' "$1"; else printf '  FAIL  %s\n' "$1"; pass=0; fi; }
approx() { # a b -> true if within 5%
    awk -v a="$1" -v b="$2" 'BEGIN{d=(a>b?a-b:b-a); exit !(a>0 && d/a<=0.05)}'
}

echo "Verdict:"
check "req1 is cold (read==0, creation>0)" \
    "[[ ${CREATE[req1]} -gt 0 && ${READ[req1]} -eq 0 ]]"
check "replay reuse grows each turn (req2 < req3 < req4)" \
    "[[ ${READ[req2]} -lt ${READ[req3]} && ${READ[req3]} -lt ${READ[req4]} ]]"
check "navigate back to turn 2 reuses the req2 boundary (within 5%)" \
    "approx ${READ[req2]} ${READ[edit2]}"
check "navigate back to turn 3 reuses the req3 boundary (within 5%)" \
    "approx ${READ[req3]} ${READ[edit3]}"
check "navigate back to turn 4 reuses the req4 boundary (within 5%)" \
    "approx ${READ[req4]} ${READ[edit4]}"
check "deeper navigation reuses more (edit2 < edit3 < edit4)" \
    "[[ ${READ[edit2]} -lt ${READ[edit3]} && ${READ[edit3]} -lt ${READ[edit4]} ]]"
check "every navigate-back still reuses multiple turns (edit2 read >= 4000)" \
    "[[ ${READ[edit2]} -ge 4000 ]]"
echo

if [[ $pass -eq 1 ]]; then
    echo "RESULT: PROVEN -- navigating back to turn K reuses the cache up to the"
    echo "turn-(K-1) boundary, exactly as the original turn-K request did. The later"
    echo "you branch, the more of the conversation is served from cache."
else
    echo "RESULT: at least one check FAILED (see above)."
    exit 1
fi
