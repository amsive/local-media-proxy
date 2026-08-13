---
name: audit-local-media-proxy-release
description: Audit a new Local Media Proxy release, release tag, or release-candidate commit against the last audited revision or previous release. Use when a new release is produced, when asked what changed since the last audit, or when preparing an evidence-backed GitHub backlog from release changes. Runs a read-only diff-focused engineering and security review, prepares issue-ready drafts, and publishes only after explicit approval.
---

# Audit Local Media Proxy Release

## Objective

Produce a high-confidence review of only the code and release surface changed since the approved baseline. Separate investigation, issue drafting, and GitHub publication into distinct gates.

Do not modify runtime code, tests, documentation, configuration, tags, releases, branches, or pull requests while auditing. Creating this audit's GitHub issues is allowed only after the user approves the exact drafts.

## Required sequence

Follow these phases in order:

1. Resolve the release and baseline.
2. Establish the validation baseline.
3. Audit the changed surface in focused passes.
4. Validate, deduplicate, and classify candidates.
5. Present the findings table and complete issue drafts.
6. Wait for explicit publication approval.
7. Publish and verify only the approved issues.

Do not combine the review and publication gates.

## 1. Resolve the release range

Resolve both ends to immutable commits and report their full SHAs.

Choose the target in this order:

1. The release tag, release URL, or commit supplied by the user.
2. The exact `vX.Y.Z` tag associated with the newest draft or published release.
3. The newest exact SemVer tag reachable from `main`.

Choose the base in this order:

1. The target SHA from the most recent completed audit supplied in the thread or an audit artifact.
2. A user-specified baseline.
3. The previous exact SemVer release tag that is an ancestor of the target.
4. The repository root commit when no earlier release exists.

If the last audit falls between releases, prefer that audited SHA so already-reviewed commits are not rescanned. If the target does not descend from the proposed base, use their merge base and disclose the adjustment. Ask for direction only when competing baselines would materially change the review.

Before substantive review:

- Confirm the checkout, branch, worktree status, target tag, target SHA, base SHA, and ancestry.
- Inventory commits with `base..target` and content changes from the base tree to the target tree. When the base is an ancestor, use `git diff base target`; otherwise diff the resolved merge base against the target.
- State the exact two tree objects covered by the audit instead of using ambiguous range shorthand in the report.
- Follow changed shared helpers into directly affected sibling paths, but do not broaden into unrelated code.
- Do not include uncommitted work unless the user explicitly requests it.

## 2. Establish the validation baseline

Run `npm run validate` against the target revision before creating findings. Preserve the command result, test totals, skips, packaging result, and any environmental limitations.

Run validation from an isolated temporary export or checkout of the immutable target, not from the user's working tree. This is required even when the checked-out commit equals the target because validation cleans and rebuilds generated `lib/` and `dist/` content. Prefer a `git archive` export into a directory created with `mktemp -d`; install or make dependencies available only inside that isolated directory. Ask before downloading dependencies or creating Git worktree metadata when additional authority is required. Clean up only the temporary artifacts created for this audit.

Treat a sandbox denial such as loopback `listen EPERM` separately from a product failure. If permitted, rerun with the minimum additional access needed. Do not report an environmental restriction as a repository defect.

The expected validation surface includes:

- Public-release safety
- Type checking
- Node tests
- Exact installable TGZ construction and package verification

Do not switch, clean, rebuild, or overwrite the user's checkout for validation. If an isolated target environment cannot be prepared safely, document the limitation instead of running the command in place.

Existing passing tests are a baseline, not proof that no defect exists. A testing finding must identify an unprotected behavior or failure mode; "more tests would be helpful" is insufficient.

## 3. Audit the changed surface

Perform focused passes instead of one generic review:

1. Proxy security, TLS, DNS, request filtering, credentials, cookies, and privacy
2. Filesystem containment, managed configuration, snapshots, rollback, and cleanup
3. Local lifecycle, server identity, IPC, bounded waits, concurrency, settings, and migrations
4. Package integrity, public-release safety, dependencies, CI/CD, draft creation, and promotion
5. Apache/Nginx behavior, cross-platform compatibility, accessibility, themes, and developer experience
6. Maintainability and architecture where a concrete delivery, reliability, or operational cost exists

Review changed source-like files completely. Load supporting tests, documentation, configuration, and unchanged shared helpers only when needed to understand the changed behavior.

For security-sensitive changes, keep the focused engineering review and relevant deterministic regression coverage, but do not invoke a Codex Security scan automatically. Run `codex-security:security-diff-scan` only when the user explicitly requests a security scan or audit, and follow that skill's required phase sequence when requested. Keep its vulnerability disposition separate from ordinary engineering findings: a candidate can be a valid reliability defect without meeting the repository's security-reporting threshold.

Follow `SECURITY.md`. Never publish suspected vulnerability details as a public GitHub issue. Prepare a private-report recommendation instead and stop before disclosure unless the user explicitly authorizes the repository's confidential process.

## 4. Validate and consolidate candidates

Require concrete evidence before retaining a candidate. Acceptable evidence includes:

- A deterministic reproduction or failing focused test
- A reachable source-to-sink control flow with a concrete inconsistent state
- A violated documented invariant
- A configuration, packaging, or workflow contradiction
- Runtime evidence from the supported Local environment

For every candidate:

- Identify the root cause, affected paths/functions, trigger, failure mode, and observable impact.
- Record target-SHA-pinned GitHub source links when preparing an issue.
- Test relevant counterevidence and existing safeguards.
- Search all GitHub issues and pull requests for duplicates and related history.
- Consolidate occurrences that share the same root cause and implementation path.
- Split only when ownership, solution, risk, or acceptance criteria materially differ.

Reject subjective preferences, cosmetic inconsistencies, file-size-only architecture complaints, speculative risks, and work unsupported by repository evidence.

## Classification and priority

Use one classification:

- **Defect:** Current behavior can violate an intended invariant or user-visible outcome.
- **Security hardening:** A concrete control improvement without a currently supported exploit boundary.
- **Architectural opportunity:** A bounded refactor justified by measurable maintenance or reliability cost.
- **Manual-validation gap:** Important behavior cannot be closed with available automation or runtime access.

Use one confidence level:

- **Confirmed:** Reproduced, covered by deterministic evidence, or explicit in control flow without a material unresolved premise.
- **High:** Strong evidence with uncertainty limited to timing, frequency, or environment behavior.
- **Needs runtime validation:** A material premise remains unverified.

Use the repository severity scale:

- **Critical:** Credible severe compromise, data loss, privilege escalation, remote code execution, or widespread outage.
- **High:** Broken core functionality, significant security weakness, major reliability failure, severe performance issue, or major accessibility barrier.
- **Medium:** Material reliability, testing, performance, maintainability, or delivery risk.
- **Low:** Limited-scope quality, accessibility, documentation, or developer-experience impact.

Estimate effort as Small, Medium, Large, or Extra Large. Base the estimate on implementation breadth, test-harness needs, platform coverage, and migration/rollback risk rather than elapsed hours.

## 5. Findings review gate

Present every retained candidate before creating anything:

| Field | Required content |
|---|---|
| Finding | Concise problem statement |
| Classification | Defect, security hardening, architectural opportunity, or manual-validation gap |
| Evidence | Code path, test, reproduction, runtime result, or violated invariant |
| Severity | Critical, High, Medium, or Low |
| Confidence | Confirmed, High, or Needs runtime validation |
| Effort | Small, Medium, Large, or Extra Large |
| Existing tracking | Duplicate issue, related PR, private advisory, or untracked |
| Recommendation | Create, consolidate, defer, private review, or reject |

Recommend immediate issue creation only for confirmed defects and well-supported hardening work. Keep architectural opportunities as recommendations until their cost, bounded approach, regression protection, and value justify the refactor risk.

Then prepare a complete draft for every recommended issue containing:

- Concise title
- Problem summary
- Supporting evidence with target-pinned links
- Affected components
- Technical and user/business impact
- Expected behavior
- Recommended implementation direction without implementing it
- Explicit acceptance criteria
- Recommended validation coverage
- Severity, confidence, and estimated effort
- Related issues and pull requests

Stop after presenting the drafts. Do not interpret approval to run the audit as approval to publish its results.

## 6. Publication gate

Require explicit approval of the drafts, such as "publish both" or an equally clear selection. If the user requests edits, revise and show the affected drafts again before publication.

Immediately before creating approved issues:

1. Recheck open and closed issues for duplicates.
2. Read the repository's current labels and use only existing appropriate labels.
3. Inspect accessible repository or organization GitHub Projects and their fields.
4. Keep severity, confidence, and effort in the issue body when matching labels or fields do not exist.
5. If a configured Project exists but access is unavailable, request the required scope before creating issues so they are not left partially configured.
6. If no Project is configured, create the repository issues and state that no project item was available.

After creation, reread each issue and verify its title, body, links, label, state, and Project fields. Report the final URLs. Do not create branches, commits, pull requests, or fixes as part of this skill.

## Final report

Conclude with:

- Base and target revisions
- Validation baseline and limitations
- Overall health of the changed release surface
- New issues created or drafts awaiting approval, grouped by severity
- Existing tracking referenced instead of duplicated
- Deferred, rejected, and private-review candidates
- Highest-priority risks and systemic concerns
- Runtime or manual checks still required
- Recommended implementation order
- Confirmation that the repository worktree remained unchanged during the audit

Never call the review exhaustive when runtime access, official Local fixtures, supported platforms, or required external context were unavailable.

## Completion criteria

The release audit is complete only when:

- The immutable base and target are recorded.
- Every changed source-like file has a review disposition.
- All retained candidates have evidence and counterevidence.
- Duplicate and root-cause consolidation checks are complete.
- Validation results and limitations are documented.
- Issue drafts have passed the user review gate.
- Any approved GitHub issues have been reread and verified after creation.
- No unauthorized repository, release, or GitHub changes were made.
