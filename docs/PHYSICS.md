# Physics and tuning

The authoritative simulation advances at `FIXED_DT` and uses deterministic
trigonometry from `src/sim/detmath.ts`. Course speed, inputs, collisions, and
landing outcomes are replayed at that fixed step; do not replace its math with
frame-time-dependent updates.

## Vehicle and motion

| Constant | Value | Purpose |
| --- | ---: | --- |
| `FIXED_DT` | `1 / 120 s` | Replay-stable simulation step. |
| `MAX_RUN_SECONDS` | `1,200 s` | Hard run-duration limit. |
| `CAR_LENGTH` | `120 units` | Collision/body length and course clearances. |
| `CAR_HEIGHT` | `34 units` | Vehicle body scale. |
| `WHEELBASE` | `84 units` | Front-to-rear wheel contact spacing. |
| `WHEEL_RADIUS` | `9 units` | Wheel contact and ground-pose offset. |
| `WHEEL_VERTICAL_OFFSET` | `CAR_HEIGHT × 0.32` | Wheel-center offset below the vehicle center. |
| `BODY_RADIUS` | `CAR_HEIGHT × 0.30` | Radius of the three circles used for body collisions. |
| `START_SPEED` | `430 units/s` | Initial horizontal speed. |
| `MAX_SPEED` | `980 units/s` | Speed cap after the ramp. |
| `SPEED_RAMP_SECONDS` | `90 s` | Duration of the quadratic ease-out speed increase. |
| `GRAVITY` | `1,200 units/s²` | Downward acceleration while airborne. |
| `JUMP_VELOCITY` | `−520 units/s` | Ordinary grounded jump impulse. |
| `SUPER_JUMP_VELOCITY` | `−740 units/s` | Added impulse for a manual launch-window press. |
| `LAUNCH_BOOST` | `−600 units/s` | Environmental impulse from a glowing launch ramp. |
| `LAUNCH_WINDOW_FRACTION` | `0.25` | Final fraction of a launch ramp that upgrades a press to super launch. |
| `MIN_AUTO_TAKEOFF_VELOCITY` | `−150 units/s` | Minimum upward crest velocity for an automatic takeoff. |
| `ROTATION_ACCEL` | `24 rad/s²` | Forward angular acceleration while held in the air; tuned for rail half-flips. |
| `MAX_ANGULAR_SPEED` | `8.5 rad/s` | Maximum forward rotation rate. |
| `RELEASE_DAMPING_PER_STEP` | `0.94333544987349216` | Per-step angular-velocity damping, equivalent to `exp(−7 × FIXED_DT)`. |
| Grounded angular damping | `0.5 per step` | Settles angular velocity while the car is on a surface. |
| Near-level stabilization | `0.55 rad`, strength `0.35` | Gently nudges released rotation toward level only near horizontal. |

## Thruster resources

| Constant | Value | Purpose |
| --- | ---: | --- |
| `ENERGY_MAX` | `100` | Shared cap for rotation and cold-gas bursts. |
| `ENERGY_GROUNDED_REGEN` | `3 units/s` | Slow energy refill while grounded. |
| `ROTATION_ENERGY_PER_SECOND` | `45 units/s` | Cost of holding rotation in the air. |
| `BURST_ENERGY` | `18 units` | Cost of one fresh airborne-press burst. |
| `BURST_COOLDOWN` | `0.4 s` | Minimum delay between bursts. |
| `BURST_COUNT_PER_AIR_PHASE` | `2` | Maximum number of bursts before the next landing. |
| `BURST_LIFT_VELOCITY` | `−170 units/s` | Added upward velocity when a burst is used with `vy > BURST_LIFT_LIMIT`. |
| `BURST_LIFT_LIMIT` | `−200 units/s` | Bursts do not add lift while already rising faster than this. |
| `BURST_ROTATION_KICK` | `1.25 rad/s` | Small forward angular-velocity impulse on a successful burst. |
| `FAN_MAX` | `100` | Separate suction-fan resource cap. |
| `FAN_DRAIN` | `45 units/s` | Fan drain while attached to an overhead rail. |
| `FAN_GROUNDED_REFILL` | `30 units/s` | Fan refill while grounded. |
| `SUCTION_ALIGN` | `π / 3 rad` | Maximum angle error from inverted (`π`) for automatic engagement. |
| `SUCTION_POINTS_PER_SECOND` | `150` | Base score reward per complete second inverted; current combo scales the reward. |

The ground press starts a jump and never rotates or bursts. A new press during
airtime may burst if its count, cooldown, and energy allow it; holding then
continues the normal rotation control.

## Contacts, landings, and hazards

| Constant | Value | Purpose |
| --- | ---: | --- |
| `LANDING_LIMIT` | `38°` | Maximum car-to-surface angle difference before a bad-landing crash. |
| `PERFECT_LIMIT` | `7°` | Angle window for a perfect landing. |
| `GREAT_LIMIT` | `16°` | Angle window for a great landing; larger safe angles are clean. |
| `MIN_REWARD_AIRTIME` | `0.3 s` | Minimum airtime for a landing reward unless a flip was completed. |
| `SNAP_TOLERANCE` | `6 units` | Base above-surface allowance for a wheel's prior-step landing check; vertical speed adds `|vy| × FIXED_DT`. |
| `HARD_IMPACT` | `1,250 units/s` | Safe impact threshold; faster survivable contacts lose one landing-quality tier. |
| `CRASH_IMPACT` | `1,900 units/s` | Surface-normal impact above this crashes with `bad-landing`. |
| `GAP_FALL_LIMIT` | `140 units` | Body-bottom depth below the gap rim that triggers a prompt `fell` crash. |
| `AIRBORNE_FALL_LIMIT` | `900 units` | General fall-depth fallback outside the more specific gap check. |
| `NEAR_MISS_CLEARANCE` | `22 units` | Maximum clearance for a near-miss reward. |
| `HAZARD_RECOVERY_SECONDS` | `0.35 s` | Recovery spacing used to keep generated hazards fair. |
| `BASE_Y` | `520 units` | Course baseline surface and default pit-rim height. |

Landing impact is the absolute velocity component normal to the contacted
surface. A valid wheel contact must cross the surface from above; falling below
a gap rim cannot be rescued by snapping onto the far edge.

## Course and replay rules

Plain gaps have a flat or level-platform approach of at least `1.5 ×
CAR_LENGTH`. Their width remains bounded by the normal jump reach. The only
current terrain that may automatically propel a car across a gap is a launch
ramp; a concave three-piece quarter-pipe is a separate automatic suction-route
launch. Fan rails span `0.95 ×` the speed at their start, over a safe flat floor;
their quarter-pipe approach, down-sloping landing ramp, and `0.9 ×`-speed flat
runout are protected from hazards. The fixed-step simulation owns all contact
and movement outcomes, while renderers may interpolate but must not alter
state.

## Rail auto-recovery

The rail zone spans the quarter-pipe start through the end of the flat runout
after the exit slope. While airborne or inverted in that zone, a car remains
eligible for recovery until it genuinely grounds, even if it travels beyond
the zone boundary before landing. A descending car that remains misaligned
near its predicted landing is automatically rotated toward the landing slope
at `RECOVERY_ANGULAR_SPEED` only when both its current and projected landing
error exceed `RECOVERY_TRIGGER_OFF`. The projected angle includes the current
angular velocity over the time-to-ground estimate. A recovery landing is a
safe, unrewarded touchdown; a car already within the trigger angle, or rotating
toward upright fast enough, retains normal landing control and rewards. As a
last resort, an otherwise-crashing contact during a sticky rail phase becomes
a `hardSnap` recovery touchdown.

| Constant | Value | Purpose |
| --- | ---: | --- |
| `RECOVERY_ANGULAR_SPEED` | `10 rad/s` | Constant angular speed used to right the car. |
| `RECOVERY_MARGIN` | `0.12 s` | Additional time margin used to decide when correction must start. |
| `RECOVERY_TRIGGER_OFF` | `LANDING_LIMIT - 2°` (`36°`) | Minimum current and predicted angle error before recovery takes control. |
