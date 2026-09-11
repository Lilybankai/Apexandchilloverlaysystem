-- 0019_strategy_corpus_readiness.sql — admin_strategy_corpus() scores every
-- coefficient the fit needs, and reads the refuel rate per CLASS.
--
-- ## Why
-- 0015 shipped the card that answers "do we have enough data yet?", and it
-- answered for two of the five coefficients in docs/RACE-STRATEGY-ENGINE.md §6:
-- burnBaseLPerLap and refuelLPerSec. The other three — kFuelSecPerL, the tyre
-- degradation pair, and kLift — went unscored, so a card showing all green
-- meant "ready to fit the two cheapest terms", which is not what a reader takes
-- from it. kFuel is the biggest lap-time term in the model (a 120 L GT3 tank is
-- ~3.6 s/lap between full and empty, larger than most tyre deg over a stint);
-- a readiness card that stays silent about it is worse than no card.
--
-- ## The refuel rate is a property of the CAR, not the track
-- 0015 grouped every figure by (track, class), which is right for burn (track
-- length and layout set it) and for tyre wear, and wrong for the refuel rate:
-- litres per second is the fuel rig, and LMU does not vary it by circuit. The
-- cost of getting that wrong is severe, because fuel-only race stops are the
-- scarcest row in the corpus by two orders of magnitude — the first week of
-- live data gave 2,908 laps and 27 fittable stops. Split 27 stops across 42
-- class/track pairs and exactly one pair reaches five; pooled by class the same
-- 27 stops clear the bar for the two classes most of the grid drives.
--
-- The pooled figure is measured, not assumed: across four tracks and three
-- drivers LMP2_ELMS reads p25 1.58 / median 1.58 / p75 1.61 L/s — tight enough
-- to be the physical constant it is. So the row reports BOTH: the pair's own
-- median when it has five stops of its own, the class median when it does not,
-- and which of the two it used. The quartiles ride along so a reader can see
-- whether a class constant is tight or is two stops pretending to be a median.
--
-- ## What this does NOT do
-- kLift stays unscored, deliberately. It is fitted from deliberate lift-and-
-- coast variation, drivers in the corpus do not lift on purpose, and §5 already
-- says the engine must refuse `save` until it can be fitted. A readiness chip
-- for a coefficient that will never go green is noise.
--
-- The stop filters are unchanged, including `not tyres_changed`. That flag does
-- NOT fully isolate fuel-only service — the corpus contains a GT3 stop that
-- added 23.3 L across 102 s stationary (a driver swap or a repair) sitting
-- inside the filter. Medians survive one such row, which is why every figure
-- here is a percentile and never a mean, but scripts/fit-strategy.js must
-- reject rows far below the class median rather than trust the flag. Noted, not
-- fixed here: changing the filter would move the numbers the card already
-- reports, and this migration is about scoring, not about redefining a stop.
--
-- Additive only. Every key 0015 returned is still returned with the same
-- meaning, so an older control panel against a newer database keeps working.
--
-- Re-runnable: `create or replace`.

create or replace function public.admin_strategy_corpus()
returns json
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  result json;
begin
  if not public.is_admin() then
    raise exception 'not_admin';
  end if;

  select json_build_object(
    'stops',      (select count(*) from public.pit_stops),
    'raceStops',  (select count(*) from public.pit_stops
                     where session_type = 'race' and stationary_sec >= 5),
    'fuelStops',  (select count(*) from public.pit_stops
                     where session_type = 'race' and stationary_sec >= 5
                       and fuel_added_l >= 5 and not tyres_changed),
    'stops7d',    (select count(*) from public.pit_stops
                     where created_at >= now() - interval '7 days'),
    'laps',       (select count(*) from public.lap_consumption),
    'burnLaps',   (select count(*) from public.lap_consumption
                     where fuel_used_l is not null and clean),
    'wearLaps',   (select count(*) from public.lap_consumption
                     where wear_at_line is not null and stint_lap is not null),
    'laps7d',     (select count(*) from public.lap_consumption
                     where created_at >= now() - interval '7 days'),
    'drivers',    (select count(*) from (
                     select driver_id from public.pit_stops
                     union
                     select driver_id from public.lap_consumption
                   ) d),
    'rows', (
      select coalesce(json_agg(row_to_json(r) order by (r."burnLaps" + r."raceStops") desc, r."carClass", r.track), '[]'::json)
      from (
        with keys as (
          select track_id, car_class from public.pit_stops
          union
          select track_id, car_class from public.lap_consumption
        ),
        stop_agg as (
          select track_id, car_class,
                 count(*) as stops,
                 count(*) filter (where session_type = 'race' and stationary_sec >= 5) as race_stops,
                 count(*) filter (where session_type = 'race' and stationary_sec >= 5
                                    and fuel_added_l >= 5 and not tyres_changed) as fuel_stops,
                 percentile_cont(0.5) within group (order by fuel_added_l / stationary_sec)
                   filter (where session_type = 'race' and stationary_sec >= 5
                             and fuel_added_l >= 5 and not tyres_changed) as refuel_l_per_sec
          from public.pit_stops
          group by track_id, car_class
        ),
        -- The same stops, pooled by class across every circuit. This is the
        -- figure a fit should take when a pair is short of five of its own.
        class_refuel as (
          select car_class,
                 count(*) as n,
                 count(distinct track_id) as tracks,
                 percentile_cont(0.25) within group (order by fuel_added_l / stationary_sec) as p25,
                 percentile_cont(0.50) within group (order by fuel_added_l / stationary_sec) as p50,
                 percentile_cont(0.75) within group (order by fuel_added_l / stationary_sec) as p75
          from public.pit_stops
          where session_type = 'race' and stationary_sec >= 5
            and fuel_added_l >= 5 and not tyres_changed
          group by car_class
        ),
        lap_agg as (
          select track_id, car_class,
                 count(*) as laps,
                 count(*) filter (where fuel_used_l is not null and clean) as burn_laps,
                 percentile_cont(0.5) within group (order by fuel_used_l)
                   filter (where fuel_used_l is not null and clean) as burn_l_per_lap,
                 count(*) filter (where wear_at_line is not null and stint_lap is not null) as wear_laps,
                 -- kFuel regresses lap_ms on fuel_start_l: it needs timed clean
                 -- laps AND an x-axis that actually moved across the stint.
                 count(*) filter (where fuel_start_l is not null and clean and lap_ms > 0) as kfuel_laps,
                 max(fuel_start_l) filter (where clean and lap_ms > 0)
                   - min(fuel_start_l) filter (where clean and lap_ms > 0) as load_spread_l,
                 max(capacity_l) as capacity_l,
                 -- The cliff term cannot be fitted from stints that never ran
                 -- long enough to reach one.
                 max(stint_lap) as stint_max
          from public.lap_consumption
          group by track_id, car_class
        ),
        driver_agg as (
          select track_id, car_class, count(distinct driver_id) as drivers
          from (
            select track_id, car_class, driver_id from public.pit_stops
            union
            select track_id, car_class, driver_id from public.lap_consumption
          ) u
          group by track_id, car_class
        )
        select k.car_class                                  as "carClass",
               coalesce(t.name, '?')                        as track,
               coalesce(s.stops, 0)                         as stops,
               coalesce(s.race_stops, 0)                    as "raceStops",
               coalesce(s.fuel_stops, 0)                    as "fuelStops",
               round(s.refuel_l_per_sec::numeric, 2)        as "refuelLPerSec",
               coalesce(l.laps, 0)                          as laps,
               coalesce(l.burn_laps, 0)                     as "burnLaps",
               round(l.burn_l_per_lap::numeric, 2)          as "burnLPerLap",
               coalesce(l.wear_laps, 0)                     as "wearLaps",
               coalesce(d.drivers, 0)                       as drivers,

               -- kFuel and tyre inputs, so the card can say WHY a chip is grey.
               coalesce(l.kfuel_laps, 0)                    as "kFuelLaps",
               round(l.load_spread_l::numeric, 0)           as "loadSpreadL",
               round(l.capacity_l::numeric, 0)              as "capacityL",
               coalesce(l.stint_max, 0)                     as "stintMax",

               -- The class-pooled refuel rate and how trustworthy it looks.
               coalesce(cr.n, 0)                            as "refuelClassStops",
               coalesce(cr.tracks, 0)                       as "refuelClassTracks",
               round(cr.p50::numeric, 2)                    as "refuelClassLPerSec",
               round(cr.p25::numeric, 2)                    as "refuelClassP25",
               round(cr.p75::numeric, 2)                    as "refuelClassP75",
               -- Which median a fit should take for this pair, and from where.
               case when coalesce(s.fuel_stops, 0) >= 5 then 'pair'
                    when coalesce(cr.n, 0) >= 5         then 'class'
                    else null end                           as "refuelSource",
               case when coalesce(s.fuel_stops, 0) >= 5 then round(s.refuel_l_per_sec::numeric, 2)
                    when coalesce(cr.n, 0) >= 5         then round(cr.p50::numeric, 2)
                    else null end                           as "refuelUsedLPerSec",

               -- The four verdicts. Bars from docs/RACE-STRATEGY-ENGINE.md §6,
               -- and §5 for the two this migration adds.
               (coalesce(l.burn_laps, 0) >= 30)             as "fitBurn",
               (coalesce(s.fuel_stops, 0) >= 5
                  or coalesce(cr.n, 0) >= 5)                as "fitRefuel",
               (coalesce(l.kfuel_laps, 0) >= 30
                  and l.load_spread_l >= 0.40 * nullif(l.capacity_l, 0))
                                                            as "fitKFuel",
               (coalesce(l.wear_laps, 0) >= 30
                  and coalesce(l.stint_max, 0) >= 15)       as "fitTyre"
        from keys k
        left join public.tracks t    on t.id = k.track_id
        left join stop_agg      s    on s.track_id = k.track_id and s.car_class = k.car_class
        left join lap_agg       l    on l.track_id = k.track_id and l.car_class = k.car_class
        left join driver_agg    d    on d.track_id = k.track_id and d.car_class = k.car_class
        left join class_refuel  cr   on cr.car_class = k.car_class
      ) r
    )
  ) into result;
  return result;
end;
$$;

revoke all on function public.admin_strategy_corpus() from public, anon;
grant execute on function public.admin_strategy_corpus() to authenticated;
