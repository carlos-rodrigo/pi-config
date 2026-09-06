# Workflow router

Automatic task routing with **GPT-6 Astra medium** as both the startup default and classifier fallback. A separate **GPT-5.6 Luna low** call classifies each independent user request before the primary model starts. No keyword rules choose the model.

## Controls

| Entry | Behavior |
|---|---|
| `/classify <request>` | Preview the LLM recommendation and suggested tools; no primary-model switch |
| `classify_task` tool | The same preview, with nested usage returned to Pi |
| `/route` | Show routing state and the last decision in this runtime |
| `/route <request>` | Preview without executing the request |
| `/route lock` | Keep the current model/effort; ordinary Pi model controls still work |
| `/route auto` | Resume routing and select Astra medium |
| `--routing auto` | Opt into routing, including with CLI model/thinking flags |
| `--routing lock` | Disable automatic classification and switching |

Selecting `/model` or changing reasoning does not disable auto routing. It cancels any in-flight classifier decision so that an older result cannot overwrite that selection. The next independent request is classified normally. Legacy `/fast`, `/smart`, `/deep`, `/max` presets explicitly lock routing; `/route auto` releases them.

Explicit `--model`, `--models`, and `--thinking` flags lock routing by default so background agents/loops retain their configured models. `--routing auto` opts those invocations in. Existing legacy mode entries restore a lock; use `/route auto` once to migrate an old session. Explicit previews still call the classifier while routing is locked.

## Response timeline

After the user message and before every provider call in its response, the router adds a compact, durable TUI-only legend. Tool continuations and retries repeat the legend because each starts another model generation:

```text
GPT-6 Astra · medium · Fallback  ▸ ctrl+o reason
```

The legend records the **actual** active model and effective effort, not only the recommendation. Its routing state is:

- **Auto** — classification and route application succeeded.
- **Manual** — routing is locked, so the current model and effort were retained.
- **Fallback** — classification failed, the target was unavailable, or Pi clamped the requested effort.

Use Pi's configured `app.tools.expand` shortcut (Ctrl+O by default) to reveal the bounded routing reason. The shortcut hint appears on the first legend only; later rows retain a compact `▸ reason` affordance. Legends are custom session entries, so they render again after reload/resume but never enter LLM context. Queued continuations and extension-triggered responses receive a legend for the retained route without triggering a new classification. The active response route is cleared only after Pi fully settles, so tool turns cannot lose their provenance.

The bordered composer no longer repeats workflow mode, model, or effort. It keeps transient classifier progress, context/cost, active extension status, project path, and background activity.

## Classification

The Luna call receives:

- The current request, up to 8,000 characters. Larger requests fall back to Astra medium instead of silently classifying a truncated request.
- Up to four recent user/assistant messages or compaction summaries, capped at 1,500 characters each. Context comes from the active, compacted branch. Tool outputs and hidden reasoning are excluded.
- An attachment-presence marker; image bytes are not sent to the classifier.
- Fixed descriptions of the allowed profiles, task types, strategies, and reason codes.

The classifier must distinguish the requested action from the topic being discussed. An explanation about database migration is an answer, not a migration. “Implement this” after a lookup must be reassessed using the conversation, not treated as another lookup.

| Profile | Intended use |
|---|---|
| `luna-medium` | Explicit, simple, low-risk answers, lookups, or edits |
| `sol-medium` | Ordinary implementation/debugging with bounded scope |
| `astra-medium` | **Default:** routine coding, debugging, review, research, uncertainty, and context-dependent follow-ups needing Astra judgment |
| `astra-high` | Complex multi-module debugging, constrained architecture decisions, security/financial implementation |
| `astra-xhigh` | Explicit deep/long-running/adversarial work, or evidence in the current request/context that a medium/high attempt was insufficient |
| `astra-max` | Explicit maximum effort, high-consequence migrations, production-critical work, exhaustive investigation/verification |

Ambiguity, breadth, prior conversation, and serious topic words alone do not justify xhigh. Ordinary complex work uses high; insufficient context uses medium. An xhigh result must carry `deep-scope` or `lower-effort-insufficient`; any other reason is rejected and falls back to Astra medium. Luna assesses the evidence in the bounded conversation—this is not an automatic measurement of whether xhigh improves task outcomes. Explicit `/deep` and `/max` presets remain unchanged.

Output is validated against predefined profile, task, strategy, and reason enums. Unknown models/tools, extra fields, free-text reasons, malformed JSON, and non-completed responses are rejected. Reason codes become fixed human-readable explanations, preventing request text from being copied into routing receipts. There is no self-reported confidence score.

The classifier has no tools. Strategies are advisory, filtered to currently active tools, and cannot change permissions, execute commands, launch agents, or alter Ollama configuration. Existing authorization and verification requirements remain binding.

## Failure and lifecycle behavior

The total auth-plus-completion deadline is eight seconds, with low reasoning and a 1,024-token output cap. Missing model/auth, invalid output, provider failure, or deadline expiry yields Astra medium. There is no retry or second classifier model. Cancellation aborts classification instead of applying a fallback, and late responses cannot override a subsequent lock, model change, session shutdown, or branch navigation.

The `input` hook captures idle user submissions; `before_agent_start` classifies and applies the result before the primary call. **Streaming steering, queued continuations, and extension-generated follow-ups retain the current model.** The installed Pi queue continues an existing agent loop without a new `before_agent_start` boundary.

Missing, unauthenticated, out-of-scope, or incompatible execution targets preserve the current model/effort with a warning. Guards account for pending request text, unknown post-compaction usage, and retained image context. Same-model routes avoid redundant model selections. Pi's effective reasoning effort is recorded separately from the request, including clamping.

Controls and decisions persist as branch-local `workflow-router-control` and `workflow-route` entries; visible `workflow-route-legend` entries preserve per-response presentation state. Reload/resume/fork preserve existing route state instead of resetting automatic sessions to the default. Default changes take effect immediately with `/route auto` or in a new unpinned session.

## Evidence and cost

Each automatic receipt records the route, actual model/effort, classifier status, latency, and available usage. With `self-improvement-archive` loaded, session-correlated notes include status, latency, tokens, and cost alongside existing run/verification records. Request/context text is not written into these receipts; it is sent to the same configured OpenAI Codex provider for classification.

Automatic classification costs are recorded in routing evidence, not added to the main completion's footer totals. `classify_task` returns its nested usage to Pi. Usage may be unavailable on timeouts/errors even if the provider incurred partial cost.

The opt-in live evaluation in `live.eval.ts` checks routine coding, unclear requests, conversational transitions, topic-versus-action distinctions, and high/xhigh/max controls using synthetic context. It requires successful classification, so a medium fallback cannot pass as correct routing. This is a small smoke sample, not proof of general classification accuracy or optimal effort.

## Architecture and verification

- `classifier.ts`: bounded context, fixed policy prompt, Luna adapter, deadline, strict output validation, fallback.
- `index.ts`: controls, cancellation/lifecycle, model application, advisory hints, receipts, and response legends.
- `../lib/model-profiles.ts`: shared execution profiles and legacy presets.

Run `npm run test:workflow-router` and `bash scripts/verify.sh`. Unit tests use controlled classifier responses and cover startup/auto at Astra medium, xhigh reason validation, high/xhigh application and subsequent de-escalation, legacy locks, fallback, cancellation, retained context/images, and actual-settings legends.

Run `node --test extensions/workflow-router/live.eval.ts` explicitly for paid Luna-low evaluation with your configured Pi credentials. It does not execute the sample requests, switch an execution model, or read user-session history. This network check is excluded from the ordinary test suite.

Included by the package extension glob. Symlink installations need the new directory installed once, followed by `/reload` and `/route auto` in an existing session.
