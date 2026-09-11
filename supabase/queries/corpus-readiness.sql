-- corpus-readiness.sql — the strategy corpus, interrogated by hand.
--
-- The Admin panel's "Strategy corpus" card (admin_strategy_corpus(), migration
-- 0019) answers the everyday question: which class/track pairs can have their
-- coefficients fitted. This file is for the questions the card deliberately
-- does not show — the ones you ask when a number on it looks wrong, or when
-- scripts/fit-strategy.js is about to trust something it should not.
--
-- Run in the Supabase SQL editor as service role. Nothing here writes.
-- Every figure is a percentile, never a mean: see query 3 for why.

-- ---------------------------------------------------------------------------
-- 1. Readiness per class x track — the card's own table, with the raw inputs
--    that produced each verdict, so a grey chip can be traced to the bar it
--    missed rather than guessed at.
--
--    Bars, from docs/RACE-STRATEGY-ENGINE.md §6 and §5:
--      burn    >= 30 clean laps with a measured fuel_used_l
--      refuel  >= 5 fuel-only race stops (>=5 L, no tyres, >=5 s stationary),
--                counted per CLASS, not per pair — the fuel rig belongs to the
--                car and LMU does not vary it by circuit
--      kFuel   >= 30 clean timed laps AND a fuel-load spread >= 40% of capacity
--                (regressing lap_ms on fuel_start_l needs the x-axis to move)
--      tyre    >= 30 laps with wear + stint_lap AND max stint_lap >= 15
--                (the cliff term needs a stint that actually ran past one)
-- ---------------------------------------------------------------------------
with class_refuel as (
  select car_class,
         count(*) as n,
         count(distinct track_id) as tracks,
         percentile_cont(0.50) within group (order by fuel_added_l / stationary_sec) as p50
  from public.pit_stops
  where session_type = 'race' and stationary_sec >= 5
    and fuel_added_l >= 5 and not tyres_changed
  group by car_class
),
stop_agg as (
  select track_id, car_class,
         count(*) filter (where session_type = 'race' and stationary_sec >= 5
                            and fuel_added_l >= 5 and not tyres_changed) as fuel_stops,
         percentile_cont(0.5) within group (order by fuel_added_l / stationary_sec)
           filter (where session_type = 'race' and stationary_sec >= 5
                     and fuel_added_l >= 5 and not tyres_changed) as refuel_lps
  from public.pit_stops group by 1, 2
),
lap_agg as (
  select track_id, car_class,
         count(*) filter (where fuel_used_l is not null and clean) as burn_laps,
         percentile_cont(0.5) within group (order by fuel_used_l)
           filter (where fuel_used_l is not null and clean) as burn_l,
         count(*) filter (where fuel_start_l is not null and clean and lap_ms > 0) as kfuel_laps,
         max(fuel_start_l) filter (where clean and lap_ms > 0)
           - min(fuel_start_l) filter (where clean and lap_ms > 0) as spread_l,
         max(capacity_l) as cap_l,
         count(*) filter (where wear_at_line is not null and stint_lap is not null) as wear_laps,
         max(stint_lap) as stint_max,
         count(distinct driver_id) as drivers
  from public.lap_consumption group by 1, 2
)
select coalesce(t.name, '?') as track, k.car_class as class, l.drivers,
       case when coalesce(l.burn_laps,0) >= 30 then 'B' else '-' end
         || case when coalesce(l.kfuel_laps,0) >= 30
                  and l.spread_l >= 0.40 * nullif(l.cap_l,0) then 'K' else '-' end
         || case when coalesce(l.wear_laps,0) >= 30
                  and coalesce(l.stint_max,0) >= 15 then 'T' else '-' end
         || case when coalesce(s.fuel_stops,0) >= 5
                  or coalesce(cr.n,0) >= 5 then 'R' else '-' end       as fits,
       coalesce(l.burn_laps,0) as burn_n, round(l.burn_l::numeric,2)   as burn_l,
       coalesce(l.kfuel_laps,0) as kf_n,
       round(l.spread_l::numeric,0) as spread_l,
       round((0.40*l.cap_l)::numeric,0) as spread_needed,
       coalesce(l.wear_laps,0) as wear_n, coalesce(l.stint_max,0) as stint_max,
       coalesce(s.fuel_stops,0) as pair_stops, round(s.refuel_lps::numeric,2) as pair_lps,
       coalesce(cr.n,0) as class_stops, round(cr.p50::numeric,2) as class_lps
from (select track_id, car_class from public.lap_consumption
      union
      select track_id, car_class from public.pit_stops) k
left join public.tracks t  on t.id = k.track_id
left join lap_agg      l   on l.track_id = k.track_id and l.car_class = k.car_class
left join stop_agg     s   on s.track_id = k.track_id and s.car_class = k.car_class
left join class_refuel cr  on cr.car_class = k.car_class
order by coalesce(l.burn_laps,0) desc, track, class;

-- ---------------------------------------------------------------------------
-- 2. The refuel rate pooled per class, with quartiles.
--
--    This is the query that justifies pooling. A class whose p25 and p75 sit
--    within a few hundredths of the median is reporting a physical constant
--    and can be trusted on a handful of stops; a class whose quartiles are a
--    factor apart is two stops pretending to be a median, and the fit must
--    refuse it however many rows it has. Read the SPREAD, not just the n.
-- ---------------------------------------------------------------------------
select car_class,
       count(*) as fuel_stops,
       count(distinct track_id) as tracks,
       count(distinct driver_id) as drivers,
       round(percentile_cont(0.25) within group (order by fuel_added_l/stationary_sec)::numeric,2) as p25,
       round(percentile_cont(0.50) within group (order by fuel_added_l/stationary_sec)::numeric,2) as median,
       round(percentile_cont(0.75) within group (order by fuel_added_l/stationary_sec)::numeric,2) as p75,
       round((percentile_cont(0.75) within group (order by fuel_added_l/stationary_sec)
            - percentile_cont(0.25) within group (order by fuel_added_l/stationary_sec))::numeric,2) as iqr
from public.pit_stops
where session_type = 'race' and stationary_sec >= 5
  and fuel_added_l >= 5 and not tyres_changed
group by car_class
order by fuel_stops desc;

-- ---------------------------------------------------------------------------
-- 3. Contaminated stops — the reason nothing above is ever a mean.
--
--    `not tyres_changed` does NOT isolate fuel-only service. A driver swap, a
--    repair or a crew that kept the car waiting all land inside the filter with
--    the car stationary for far longer than the fuel explains, and each one
--    drags a refuel rate down. This lists the stops whose implied litres per
--    second fall well below their own class median — the rows a fit must drop.
--
--    `booked_sec` is NOT a usable cross-check today: LMU reports 2.0 s on stops
--    that took 60 L aboard, so the sim's own booked-service total appears to be
--    sampled before the service is booked. §5 of the strategy doc wants to
--    prefer it for the stationary part of pit loss; until that read is fixed it
--    cannot be. It is shown here so the breakage stays visible.
-- ---------------------------------------------------------------------------
with class_refuel as (
  select car_class,
         percentile_cont(0.50) within group (order by fuel_added_l / stationary_sec) as p50
  from public.pit_stops
  where session_type = 'race' and stationary_sec >= 5
    and fuel_added_l >= 5 and not tyres_changed
  group by car_class
)
select p.car_class,
       coalesce(t.name,'?') as track,
       round(p.fuel_added_l::numeric,1)   as added_l,
       round(p.stationary_sec::numeric,1) as stat_s,
       round(p.lane_sec::numeric,1)       as lane_s,
       round(p.booked_sec::numeric,1)     as booked_s,
       round((p.fuel_added_l/p.stationary_sec)::numeric,2) as lps,
       round(cr.p50::numeric,2)                            as class_lps,
       round((100.0*(p.fuel_added_l/p.stationary_sec)/nullif(cr.p50,0))::numeric,0) as pct_of_class
from public.pit_stops p
join class_refuel cr on cr.car_class = p.car_class
left join public.tracks t on t.id = p.track_id
where p.session_type = 'race' and p.stationary_sec >= 5
  and p.fuel_added_l >= 5 and not p.tyres_changed
  -- Under 70% of the class median: the fuel cannot account for the time.
  and (p.fuel_added_l / p.stationary_sec) < 0.70 * cr.p50
order by pct_of_class asc;
