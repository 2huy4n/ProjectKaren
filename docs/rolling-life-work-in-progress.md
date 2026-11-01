# Rolling fictional life

Karen's 20-second session heartbeat owns the rolling planner. When enabled, it
migrates the legacy current action into the per-session `life` record in the
existing `project-karen.json` file. It retains activities and their explicit
states, recent history, future activities, daily anchors, and a bounded set of
persistent consequences. Planned end times and planning responses cannot complete
an activity. Completion requires a separate identified `karen_action` tool call
with `completeActivityId`; optional `consequences` record up to five durable facts.
The label and identifier must match an in-progress activity. Repeated confirmation
is idempotent. Missed activities are postponed
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
retry after five minutes. Offline tests exercise DSH prompt assembly and middleware;
a small isolated live review also used synthetic session data and a separate
budget. Each deployment should verify its own prompt assembly, accounting, message
routing and delivery integration before rollout.

The planner's significant consequences are limited to explicit confirmations;
conversation is provided as context and is not automatically converted into
world state. Anchor and fact selection remain model-dependent. There is no
semantic guarantee that a model's chosen description is true; invalid timing,
conflicts, missing resolution reasons and stale results are rejected.

## Verification status

The rolling planner and pause/resume behavior have offline coverage. The installed
DSH service check uses synthetic middleware; it does not exercise every deployment's
prompt, accounting, batching, or delivery components. A small isolated live review exercised planning and sleep/wake; it did not test
every integration or extended behavior. Deployments should assess their integration
and rollback procedures separately before enabling this feature.

Unresolved anchors are retained even after their planned end, until explicitly
cancelled or matched to a confirmed completed activity. Planning context selects a
bounded set of upcoming and overdue anchors; the full set remains in persistent
state and conflict checks. Hosts that rewrite tool schemas must preserve the
`completeActivityId` and `consequences` properties on `karen_action`.

## Unresolved activity capacity

Planned, in-progress and postponed activities share a limit of 200 unresolved
records per session. Adding activities that would exceed the limit is rejected;
no unresolved activity or commitment is silently deleted. Existing stores above
the limit are retained, but cannot add activities until explicitly reduced. The
planner receives the remaining capacity and bounded older postponed records. It
can resume a postponed activity by ID (preserving its ID and previous postponement),
or explicitly cancel or skip one with a reason. These changes are validated
against other activities, anchors, the planning window and sleep boundaries.
Completed, cancelled, skipped and interrupted history remains capped separately.
Unresolved anchors are retained independently of this activity capacity.

`npm ci` installs the pinned DSH test dependencies. `npm test` runs both the DSH
integration test and unit tests. CI uses the same commands. Tests require no
provider credentials, Telegram connection, or production state.
