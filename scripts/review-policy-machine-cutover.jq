# Offline jq filter for the human-review -> Argus+CI machine-policy cutover of the `master` ruleset (TECH-7014).
# It only transforms JSON: it never calls GitHub. A human administrator applies the output with `gh api`
# after reviewing the diff (see the cutover plan in the TECH-7014 hand-off / docs).
#
# Usage (input is the FRESH, FULL `GET /repos/redesignhealth/paperclip/rulesets/<ruleset_id>` readback):
#   jq -e --arg mode add-checks     -f scripts/review-policy-machine-cutover.jq live.json
#   jq -e --arg mode machine-review -f scripts/review-policy-machine-cutover.jq live.json
#   jq -e --arg mode restore-human --argjson human "$HUMAN_PR_PARAMETERS" -f scripts/review-policy-machine-cutover.jq live.json
#
# Order of operations (each step is one mutable-current PUT; never replay an old payload):
#   1. add-checks      Adds the required_status_checks rule for the App checks `argus-gate` and
#                      `ci-aggregate` pinned to integration 5166579 (RH PR Approval Gate, NOT the generic
#                      Actions app 15368). Human review stays required. Prove it enforces (positive, negative,
#                      forged-15368, API-error cases) BEFORE step 2.
#   2. machine-review  Requires the checks rule from step 1, then sets only the pull_request review
#                      parameters to the machine values: 0 approvals, no required reviewer team, no code-owner
#                      review, no last-push approval, and (if the key exists) no extra approval for
#                      unattributed changes. Every other parameter and rule is preserved.
#   restore-human      Rollback. Puts back the captured human pull_request `parameters` object (pass it with
#                      --argjson human) and KEEPS the machine checks rule. Revoke the App credentials only
#                      after this, and only for an incident.
#
# Guarantees: exactly one pull_request rule and at most one required_status_checks rule (else error);
# `bypass_actors`, `conditions`, unknown rules and unknown parameters are preserved exactly (no bypass is
# added or restored, no merge queue is added); only the top-level mutable fields are emitted
# {name, target, enforcement, bypass_actors, conditions, rules}, stripping read-only fields.

def app_id: 5166579;
def wanted: ["argus-gate", "ci-aggregate"];
def checks_rule: {
  type: "required_status_checks",
  parameters: {
    strict_required_status_checks_policy: false,
    do_not_enforce_on_create: false,
    required_status_checks: [wanted[] | {context: ., integration_id: app_id}]
  }
};

($ARGS.named.mode // "") as $mode
| ($ARGS.named.human // null) as $human
| if ($mode | IN("add-checks", "machine-review", "restore-human")) | not then
    error("Argument 'mode' must be one of add-checks, machine-review, restore-human")
  else . end
| ([.rules[]? | select(.type == "pull_request")] | length) as $npr
| ([.rules[]? | select(.type == "required_status_checks")] | length) as $nchk
| if $npr != 1 then
    error("Assertion failed: input ruleset must contain exactly one pull_request rule (found " + ($npr | tostring) + ")")
  elif $nchk > 1 then
    error("Assertion failed: input ruleset has multiple required_status_checks rules (" + ($nchk | tostring) + ")")
  else . end
| ([.rules[]? | select(.type == "required_status_checks") | .parameters.required_status_checks[]?
    | select(.integration_id == app_id) | .context]) as $have
| (((wanted - $have) | length) == 0) as $has_ours
| if $mode == "machine-review" and ($nchk == 0 or ($has_ours | not)) then
    error("Assertion failed: enforce the App checks first (run mode add-checks and prove it) before machine-review")
  elif $mode == "restore-human" and (($human | type) != "object"
      or (($human.required_approving_review_count // 0) < 1)
      or (($human.required_reviewers // []) | length) < 1) then
    error("Assertion failed: --argjson human must be the captured human pull_request parameters (>=1 approval and a required reviewer)")
  else . end
| .rules |= (
    if $mode == "add-checks" then
      if $nchk == 0 then
        . + [checks_rule]
      else
        map(if .type == "required_status_checks" then
              .parameters.required_status_checks as $existing
              | .parameters.required_status_checks = ($existing + [
                  wanted[] | select(. as $c | ($existing | map(select(.context == $c and .integration_id == app_id)) | length) == 0)
                  | {context: ., integration_id: app_id}
                ])
            else . end)
      end
    elif $mode == "machine-review" then
      map(if .type == "pull_request" then
            .parameters.required_approving_review_count = 0
            | .parameters.required_reviewers = []
            | .parameters.require_code_owner_review = false
            | .parameters.require_last_push_approval = false
            | (if (.parameters | has("require_extra_approval_for_unattributed_changes"))
               then .parameters.require_extra_approval_for_unattributed_changes = false else . end)
          else . end)
    else
      map(if .type == "pull_request" then .parameters = $human else . end)
    end
  )
| {
    name: .name,
    target: .target,
    enforcement: .enforcement,
    bypass_actors: .bypass_actors,
    conditions: .conditions,
    rules: .rules
  }
