/**
 * @file src/telemetry/svmMap.ts
 * @module telemetry/svmMap
 *
 * Reads a .svm setup file into the same `VM_*` / `WM_*-W_XX` key space the
 * REST API speaks, so a saved or imported tune can be STAGED in the editor and
 * applied through the proven per-key write path — the one path that provably
 * repaints LMU's own setup screen. (The API's whole-file load, PUT
 * /rest/garage/setup, changes the garage state but the game's setup menu does
 * not repaint for it; only its own UI's load button refreshes its queries.
 * Observed live 2026-08-11 — that is why loading goes through staging now.)
 *
 * The .svm grammar, from real files: `Name=<index>//<label>` lines under
 * `[SECTION]` headers, and the indices are the SAME step indices the REST API
 * uses — verified by comparing a live capture against the sim's own save of
 * the same state. The name→key table below was transcribed from a real file
 * covering every section LMU writes; names this table does not know are
 * reported, not guessed, and simply stay unstaged.
 */

/** VM_ keys by section+name, transcribed from the sim's own output. */
const SECTION_MAP: Record<string, Record<string, string>> = {
  GENERAL: {
    CGHeightSetting: 'VM_WEIGHT_VERTICAL',
    CGRightSetting: 'VM_WEIGHT_LATERAL',
    CGRearSetting: 'VM_WEIGHT_DISTRIB',
    WedgeSetting: 'VM_WEIGHT_WEDGE',
    FuelSetting: 'VM_FUEL_LEVEL',
    FuelCapacitySetting: 'VM_FUEL_CAPACITY',
    VirtualEnergySetting: 'VM_VIRTUAL_ENERGY',
    NumPitstopsSetting: 'VM_NUM_PITSTOPS',
    Pitstop1Setting: 'VM_PITSTOP_1',
    Pitstop2Setting: 'VM_PITSTOP_2',
    Pitstop3Setting: 'VM_PITSTOP_3',
  },
  LEFTFENDER: { FenderFlareSetting: 'VM_LEFT_FENDER_FLARE' },
  RIGHTFENDER: { FenderFlareSetting: 'VM_RIGHT_FENDER_FLARE' },
  FRONTWING: { FWSetting: 'VM_FRONT_WING' },
  REARWING: { RWSetting: 'VM_REAR_WING' },
  BODYAERO: {
    WaterRadiatorSetting: 'VM_WATER_RADIATOR',
    OilRadiatorSetting: 'VM_OIL_RADIATOR',
    BrakeDuctSetting: 'VM_BRAKE_DUCTS',
    BrakeDuctRearSetting: 'VM_BRAKE_DUCTS_REAR',
  },
  SUSPENSION: {
    FrontWheelTrackSetting: 'VM_FRONT_WHEEL_TRACK',
    RearWheelTrackSetting: 'VM_REAR_WHEEL_TRACK',
    FrontAntiSwaySetting: 'VM_FRONT_ANTISWAY',
    RearAntiSwaySetting: 'VM_REAR_ANTISWAY',
    FrontToeInSetting: 'VM_FRONT_TOEIN',
    FrontToeOffsetSetting: 'VM_FRONT_TOEOFFSET',
    RearToeInSetting: 'VM_REAR_TOEIN',
    RearToeOffsetSetting: 'VM_REAR_TOEOFFSET',
    LeftCasterSetting: 'VM_LEFT_CASTER',
    RightCasterSetting: 'VM_RIGHT_CASTER',
    LeftTrackBarSetting: 'VM_LEFT_TRACK_BAR',
    RightTrackBarSetting: 'VM_RIGHT_TRACK_BAR',
    Front3rdPackerSetting: 'VM_FRONT_3RD_PACKERS',
    Front3rdSpringSetting: 'VM_FRONT_3RD_SPRING',
    Front3rdTenderSpringSetting: 'VM_FRONT_3RD_TENDERSPRING',
    Front3rdTenderTravelSetting: 'VM_FRONT_3RD_TENDERSPRINGTRAVEL',
    Front3rdSlowBumpSetting: 'VM_FRONT_3RD_SLOWBUMP',
    Front3rdFastBumpSetting: 'VM_FRONT_3RD_FASTBUMP',
    Front3rdSlowReboundSetting: 'VM_FRONT_3RD_SLOWREBOUND',
    Front3rdFastReboundSetting: 'VM_FRONT_3RD_FASTREBOUND',
    Rear3rdPackerSetting: 'VM_REAR_3RD_PACKERS',
    Rear3rdSpringSetting: 'VM_REAR_3RD_SPRING',
    Rear3rdTenderSpringSetting: 'VM_REAR_3RD_TENDERSPRING',
    Rear3rdTenderTravelSetting: 'VM_REAR_3RD_TENDERSPRINGTRAVEL',
    Rear3rdSlowBumpSetting: 'VM_REAR_3RD_SLOWBUMP',
    Rear3rdFastBumpSetting: 'VM_REAR_3RD_FASTBUMP',
    Rear3rdSlowReboundSetting: 'VM_REAR_3RD_SLOWREBOUND',
    Rear3rdFastReboundSetting: 'VM_REAR_3RD_FASTREBOUND',
  },
  CONTROLS: {
    SteerLockSetting: 'VM_STEER_LOCK',
    RearBrakeSetting: 'VM_BRAKE_BALANCE',
    BrakeMigrationSetting: 'VM_BRAKE_MIGRATION',
    BrakePressureSetting: 'VM_BRAKE_PRESSURE',
    HandfrontbrakePressSetting: 'VM_HANDFRONTBRAKE_PRESSURE',
    HandbrakePressSetting: 'VM_HANDBRAKE_PRESSURE',
    TCSetting: 'VM_TRACTION_CONTROL',
    ABSSetting: 'VM_ANTILOCK_BRAKES',
    TractionControlMapSetting: 'VM_TRACTIONCONTROLMAP',
    TCPowerCutMapSetting: 'VM_TRACTIONCONTROLPOWERCUTMAP',
    TCSlipAngleMapSetting: 'VM_TRACTIONCONTROLSLIPANGLEMAP',
    AntilockBrakeSystemMapSetting: 'VM_ANTILOCKBRAKESYSTEMMAP',
  },
  ENGINE: {
    RevLimitSetting: 'VM_REV_LIMITER',
    EngineBoostSetting: 'VM_ENGINE_BOOST',
    RegenerationMapSetting: 'VM_REGEN_LEVEL',
    ElectricMotorMapSetting: 'VM_ELECTRIC_MOTOR_MAP',
    EngineMixtureSetting: 'VM_ENGINE_MIXTURE',
    EngineBrakingMapSetting: 'VM_ENGINE_BRAKEMAP',
  },
  DRIVELINE: {
    FinalDriveSetting: 'VM_GEAR_FINAL',
    ReverseSetting: 'VM_GEAR_REVERSE',
    RatioSetSetting: 'VM_RATIO_SET',
    DiffPumpSetting: 'VM_DIFF_PUMP',
    DiffPowerSetting: 'VM_DIFF_POWER',
    DiffCoastSetting: 'VM_DIFF_COAST',
    DiffPreloadSetting: 'VM_DIFF_PRELOAD',
    FrontDiffPumpSetting: 'VM_FRONT_DIFF_PUMP',
    FrontDiffPowerSetting: 'VM_FRONT_DIFF_POWER',
    FrontDiffCoastSetting: 'VM_FRONT_DIFF_COAST',
    FrontDiffPreloadSetting: 'VM_FRONT_DIFF_PRELOAD',
    RearSplitSetting: 'VM_TORQUE_SPLIT',
    GearAutoUpShiftSetting: 'VM_GEAR_AUTOUPSHIFT',
    GearAutoDownShiftSetting: 'VM_GEAR_AUTODOWNSHIFT',
  },
};

/** Corner sections → the REST corner suffix. */
const CORNER_SECTIONS: Record<string, string> = {
  FRONTLEFT: 'FL',
  FRONTRIGHT: 'FR',
  REARLEFT: 'RL',
  REARRIGHT: 'RR',
};

/** Per-corner names → the WM_ family. */
const CORNER_MAP: Record<string, string> = {
  CamberSetting: 'WM_CAMBER',
  PressureSetting: 'WM_PRESSURE',
  PackerSetting: 'WM_PACKERS',
  SpringSetting: 'WM_SPRING',
  TenderSpringSetting: 'WM_TENDERSPRING',
  TenderTravelSetting: 'WM_TENDERSPRINGTRAVEL',
  SpringRubberSetting: 'WM_SRUBBER',
  RideHeightSetting: 'WM_RIDEHEIGHT',
  SlowBumpSetting: 'WM_SLOWBUMP',
  FastBumpSetting: 'WM_FASTBUMP',
  SlowReboundSetting: 'WM_SLOWREBOUND',
  FastReboundSetting: 'WM_FASTREBOUND',
  BrakeDiscSetting: 'WM_BRAKEDISC',
  BrakePadSetting: 'WM_BRAKEPAD',
  CompoundSetting: 'WM_COMPOUND',
};

/** Numbered gears: Gear1Setting → VM_GEAR_1, up to whatever the file has. */
const GEAR_RE = /^Gear(\d+)Setting$/;

/** Numbered chassis adjustments (in [SUSPENSION]): ChassisAdj00Setting → VM_CHASSIS_ADJ_00. */
const CHASSIS_ADJ_RE = /^ChassisAdj(\d\d)Setting$/;

/** Deliberately not settings: header/meta lines every .svm carries. */
const IGNORE = new Set(['Symmetric', 'Notes', 'UpgradeSetting', 'VehicleClassSetting']);

export interface SvmParseResult {
  /** REST-space values, ready to stage: key → step index. */
  values: Record<string, number>;
  /** `Section.Name` identifiers the table could not place. */
  unmapped: string[];
  /** The header's VehicleClassSetting line, for compat display. */
  vehicleClass: string;
  symmetric: boolean;
}

/** Parses a .svm's text into REST key space. Never throws on odd lines. */
export function parseSvmValues(text: string): SvmParseResult {
  const values: Record<string, number> = {};
  const unmapped: string[] = [];
  let section = '';
  let vehicleClass = '';
  let symmetric = false;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('//')) continue;

    const sec = /^\[([A-Z0-9]+)\]$/.exec(line);
    if (sec) {
      section = sec[1]!;
      continue;
    }

    const vc = /^VehicleClassSetting="([^"]*)"/.exec(line);
    if (vc) {
      vehicleClass = vc[1]!;
      continue;
    }
    if (/^Symmetric=1/.test(line)) {
      symmetric = true;
      continue;
    }

    const kv = /^([A-Za-z0-9]+)=(-?\d+)(?:\/\/|$)/.exec(line);
    if (!kv) continue;
    const name = kv[1]!;
    const value = Number(kv[2]);
    if (IGNORE.has(name)) continue;
    // [BASIC] holds the game's simplified 0..1 sliders, not settings.
    if (section === 'BASIC') continue;

    const corner = CORNER_SECTIONS[section];
    if (corner) {
      const family = CORNER_MAP[name];
      if (family) values[`${family}-W_${corner}`] = value;
      else unmapped.push(`${section}.${name}`);
      continue;
    }

    const gear = GEAR_RE.exec(name);
    if (gear && section === 'DRIVELINE') {
      values[`VM_GEAR_${gear[1]}`] = value;
      continue;
    }

    const adj = CHASSIS_ADJ_RE.exec(name);
    if (adj && section === 'SUSPENSION') {
      values[`VM_CHASSIS_ADJ_${adj[1]}`] = value;
      continue;
    }

    const key = SECTION_MAP[section]?.[name];
    if (key) values[key] = value;
    else unmapped.push(`${section}.${name}`);
  }

  return { values, unmapped, vehicleClass, symmetric };
}
