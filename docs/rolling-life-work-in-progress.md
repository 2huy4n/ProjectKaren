# Rolling fictional life

Karen's 20-second session heartbeat owns the rolling planner. When enabled, it
migrates the legacy current action into the per-session `life` record in the
existing `project-karen.json` file. It retains activities and their explicit
states, recent history, future activities, daily anchors, and a bounded set of
persistent consequences. Planned end times alone do not complete an activity:
the planner must explicitly resolve or extend it. Missed activities are postponed
and sleep interrupts ongoing work conservatively. The existing Karen sleep and
barrage-wake calculations determine when planning can run and its boundary.

`planningEnabled` defaults to true. `planningHorizonMinutes` defaults to 180 and
is clamped to 5–1440; both are available through the normal settings endpoint
and panel. Rolling planning uses `actionEnabled` as its master activity switch.
`planningHorizonMinutes` is the length of the future window considered by the
rolling planner, not the interval between individual activities or a guarantee
that a new plan is generated exactly at each window boundary. An ongoing activity,
sleep, or an unavailable model can delay replanning. Planning context includes
the scheduler's local time and time zone as well as epoch timestamps, so time of
day is clear without inferring the character's location.

`actionIntervalMinutes` is the legacy scheduler's wait between idle-action
requests; `actionJitterMinutes` varies that wait. `actionIdleMinutes` and
`actionDailyMax` are also legacy scheduling controls. They apply only to sessions
without a rolling-life record. Once a session has been migrated, disabling
`planningEnabled` pauses rolling-plan generation and scheduled activity starts;
it does **not** restore the legacy idle-action scheduler. The current activity,
future commitments and history remain available to prompts. Sleep and wake
transitions still apply, including postponement when sleep interrupts an activity.
On re-enabling, activities whose planned starts were missed during the pause are
marked postponed and replanning is requested. An activity still in progress is
preserved until its own resolution or a sleep interruption. A planning request
already in flight may finish, but its response cannot be committed after a pause,
even if planning is re-enabled before the response arrives.

Muting proactive messages does not stop the fictional life timeline. If no DSH
model route is available, planning is deferred and the existing state is retained.

The planner uses bounded DSH session events for conversation context and reuses
the host's character/memory prompt section when available. Planning is a
separate `llm.stream` request, tagged as Karen-originated for existing middleware;
it does not inject a follow-up into the conversation or directly send messages.
The host's normal usage gate must account for it. Model output is validated before
commit, and concurrent or stale responses cannot replace newer state. Failures
retry after five minutes. Planning output and model behavior have only been tested
with offline mocks, not a paid model or production conversation. An additional
offline test exercises the installed DSH system-prompt and LLM middleware services
with a synthetic character section. Each deployment should verify its own prompt assembly, accounting, message
routing and delivery integration in isolation before rollout. These tests use no
production files, provider calls or quota.

The planner's significant consequences are limited to explicit resolutions;
conversation is provided as context and is not automatically converted into
world state. Anchor and fact selection remain model-dependent. There is no
semantic guarantee that a model's chosen description is true; invalid timing,
conflicts, missing resolution reasons and stale results are rejected.

## Verification status

The rolling planner and pause/resume behavior have offline coverage. The installed
DSH service check uses synthetic middleware; it does not exercise every deployment's
prompt, accounting, batching, or delivery components. Model behavior has not been
evaluated with live requests. Deployments should assess their integration and
rollback procedures separately before enabling this feature.
