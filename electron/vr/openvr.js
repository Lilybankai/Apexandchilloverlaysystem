/**
 * electron/vr/openvr.js — the slice of OpenVR the headset panel needs.
 * -----------------------------------------------------------------------------
 * Binds SteamVR's `openvr_api.dll` with koffi and exposes the handful of
 * IVROverlay / IVRSystem calls a world-locked panel takes. Loaded ONLY on the
 * VR worker thread (see vrWorker.js), and only once the driver has switched VR
 * on and SteamVR is actually running — nobody else ever pays for it.
 *
 * ## Why this is safe next to EAC
 *
 * Nothing here goes near the game. An overlay app talks to the SteamVR
 * compositor (vrcompositor.exe) from its own process, exactly like fpsVR,
 * Desktop+ and OVR Toolkit; the compositor draws our quad over the game's
 * frames. No injection, no API layer, no hook. See docs/VR-OVERLAY-PLAN.md.
 *
 * ## Which DLL
 *
 * The runtime's own copy, found through the path registry every OpenVR app
 * uses (%LOCALAPPDATA%\openvr\openvrpaths.vrpath → runtime → bin\win64). The
 * DLL is only a loader — the interfaces are served by the running SteamVR — so
 * shipping our own copy would buy nothing but a file to keep current.
 *
 * ## The function tables
 *
 * The C API hands out each interface as a table of plain function pointers
 * (`VR_GetGenericInterface("FnTable:IVROverlay_028")`). The ORDER of the names
 * below is the ABI: it is the member order of `VR_IVROverlay_FnTable` /
 * `VR_IVRSystem_FnTable` in openvr_capi.h for exactly the version string
 * requested, and must be regenerated from that header if the version moves.
 * SteamVR keeps serving old interface versions indefinitely, so pinning one is
 * the normal practice rather than a risk.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const IVROVERLAY_VERSION = 'IVROverlay_028';
const IVRSYSTEM_VERSION = 'IVRSystem_026';

/* Member order of VR_IVROverlay_FnTable for IVROverlay_028 (openvr_capi.h). */
const OVERLAY_FNS = [
  'FindOverlay', 'CreateOverlay', 'CreateSubviewOverlay', 'DestroyOverlay', 'GetOverlayKey',
  'GetOverlayName', 'SetOverlayName', 'GetOverlayImageData', 'GetOverlayErrorNameFromEnum',
  'SetOverlayRenderingPid', 'GetOverlayRenderingPid', 'SetOverlayFlag', 'GetOverlayFlag',
  'GetOverlayFlags', 'SetOverlayColor', 'GetOverlayColor', 'SetOverlayAlpha', 'GetOverlayAlpha',
  'SetOverlayTexelAspect', 'GetOverlayTexelAspect', 'SetOverlaySortOrder', 'GetOverlaySortOrder',
  'SetOverlayWidthInMeters', 'GetOverlayWidthInMeters', 'SetOverlayCurvature',
  'GetOverlayCurvature', 'SetOverlayPreCurvePitch', 'GetOverlayPreCurvePitch',
  'SetOverlayTextureColorSpace', 'GetOverlayTextureColorSpace', 'SetOverlayTextureBounds',
  'GetOverlayTextureBounds', 'GetOverlayTransformType', 'SetOverlayTransformAbsolute',
  'GetOverlayTransformAbsolute', 'SetOverlayTransformTrackedDeviceRelative',
  'GetOverlayTransformTrackedDeviceRelative', 'SetOverlayTransformTrackedDeviceComponent',
  'GetOverlayTransformTrackedDeviceComponent', 'SetOverlayTransformCursor',
  'GetOverlayTransformCursor', 'SetOverlayTransformProjection', 'SetSubviewPosition',
  'ShowOverlay', 'HideOverlay', 'IsOverlayVisible', 'GetTransformForOverlayCoordinates',
  'WaitFrameSync', 'PollNextOverlayEvent', 'GetOverlayInputMethod', 'SetOverlayInputMethod',
  'GetOverlayMouseScale', 'SetOverlayMouseScale', 'ComputeOverlayIntersection',
  'IsHoverTargetOverlay', 'SetOverlayIntersectionMask', 'TriggerLaserMouseHapticVibration',
  'SetOverlayCursor', 'SetOverlayCursorPositionOverride', 'ClearOverlayCursorPositionOverride',
  'SetOverlayTexture', 'ClearOverlayTexture', 'SetOverlayRaw', 'SetOverlayFromFile',
  'GetOverlayTexture', 'ReleaseNativeOverlayHandle', 'GetOverlayTextureSize',
  'CreateDashboardOverlay', 'IsDashboardVisible', 'IsActiveDashboardOverlay',
  'SetDashboardOverlaySceneProcess', 'GetDashboardOverlaySceneProcess', 'ShowDashboard',
  'GetPrimaryDashboardDevice', 'ShowKeyboard', 'ShowKeyboardForOverlay', 'GetKeyboardText',
  'HideKeyboard', 'SetKeyboardTransformAbsolute', 'SetKeyboardPositionForOverlay',
  'ShowMessageOverlay', 'CloseMessageOverlay',
];

/* Member order of VR_IVRSystem_FnTable for IVRSystem_026 (openvr_capi.h). */
const SYSTEM_FNS = [
  'GetRecommendedRenderTargetSize', 'GetProjectionMatrix', 'GetProjectionRaw',
  'ComputeDistortion', 'ComputeDistortionSet', 'GetEyeToHeadTransform', 'GetTimeSinceLastVsync',
  'GetD3D9AdapterIndex', 'GetDXGIOutputInfo', 'GetOutputDevice', 'IsDisplayOnDesktop',
  'SetDisplayVisibility', 'GetDeviceToAbsoluteTrackingPose',
  'GetSeatedZeroPoseToStandingAbsoluteTrackingPose',
  'GetRawZeroPoseToStandingAbsoluteTrackingPose', 'GetSortedTrackedDeviceIndicesOfClass',
  'GetTrackedDeviceActivityLevel', 'ApplyTransform', 'GetTrackedDeviceIndexForControllerRole',
  'GetControllerRoleForTrackedDeviceIndex', 'GetTrackedDeviceClass', 'IsTrackedDeviceConnected',
  'GetBoolTrackedDeviceProperty', 'GetFloatTrackedDeviceProperty',
  'GetInt32TrackedDeviceProperty', 'GetUint64TrackedDeviceProperty',
  'GetMatrix34TrackedDeviceProperty', 'GetArrayTrackedDeviceProperty',
  'GetStringTrackedDeviceProperty', 'GetPropErrorNameFromEnum', 'PollNextEvent',
  'PollNextEventWithPose', 'PollNextEventWithPoseAndOverlays', 'GetEventTypeNameFromEnum',
  'GetHiddenAreaMesh', 'GetEyeTrackedFoveationCenter',
  'GetEyeTrackedFoveationCenterForProjection', 'GetControllerState',
  'GetControllerStateWithPose', 'TriggerHapticPulse', 'GetButtonIdNameFromEnum',
  'GetControllerAxisTypeNameFromEnum', 'IsInputAvailable', 'IsSteamVRDrawingControllers',
  'ShouldApplicationPause', 'ShouldApplicationReduceRenderingWork', 'PerformFirmwareUpdate',
  'AcknowledgeQuit_Exiting', 'GetAppContainerFilePaths', 'GetRuntimeVersion', 'SetSDKVersion',
];

/** EVRApplicationType: talks to overlays only, submits no scene. */
const VR_APPLICATION_OVERLAY = 2;
/** ETrackingUniverseOrigin: the seated space the sim recentres. */
const TRACKING_UNIVERSE_SEATED = 0;
/** VROverlayFlags: Chromium's paint bitmaps carry premultiplied alpha. */
const OVERLAY_FLAG_PREMULTIPLIED = 1 << 21;
/** EVREventType. */
const EVENT_QUIT = 700;
/**
 * sizeof(VREvent_t) on Windows x64: three 4-byte fields padded to 16, then the
 * 48-byte VREvent_Data_t union (its largest members are six uint64s). OpenVR
 * rejects a poll whose size it does not recognise, so this must be exact.
 */
const VREVENT_SIZE = 64;

/**
 * Where SteamVR's openvr_api.dll lives, from the registry file every OpenVR app
 * reads. Null when SteamVR has never been installed or registered.
 */
function runtimeDllPath(env = process.env) {
  const local = env.LOCALAPPDATA;
  if (!local) return null;
  let runtimes = [];
  try {
    const raw = fs.readFileSync(path.join(local, 'openvr', 'openvrpaths.vrpath'), 'utf8');
    const parsed = JSON.parse(raw.replace(/^﻿/, ''));
    if (Array.isArray(parsed.runtime)) runtimes = parsed.runtime.filter((r) => typeof r === 'string');
  } catch {
    return null;
  }
  for (const root of runtimes) {
    const dll = path.join(root, 'bin', 'win64', 'openvr_api.dll');
    if (fs.existsSync(dll)) return dll;
  }
  return null;
}

/**
 * A live OpenVR session as an overlay application. Construct with
 * {@link OpenVR.connect}; every method throws only on programming errors —
 * OpenVR failures come back as EVROverlayError codes, surfaced as messages.
 */
class OpenVR {
  constructor(koffi, lib, overlayTable, systemTable) {
    this.koffi = koffi;
    this.lib = lib;
    const P = OpenVR.protos(koffi);
    const fn = (table, names, name, proto) =>
      koffi.decode(koffi.decode(table, names.indexOf(name) * 8, 'void*'), proto);

    this.o = {
      CreateOverlay: fn(overlayTable, OVERLAY_FNS, 'CreateOverlay', P.CreateOverlay),
      DestroyOverlay: fn(overlayTable, OVERLAY_FNS, 'DestroyOverlay', P.HandleOnly),
      SetOverlayFlag: fn(overlayTable, OVERLAY_FNS, 'SetOverlayFlag', P.SetFlag),
      SetOverlayWidthInMeters: fn(overlayTable, OVERLAY_FNS, 'SetOverlayWidthInMeters', P.HandleFloat),
      SetOverlayAlpha: fn(overlayTable, OVERLAY_FNS, 'SetOverlayAlpha', P.HandleFloat),
      SetOverlayTransformAbsolute: fn(overlayTable, OVERLAY_FNS, 'SetOverlayTransformAbsolute', P.SetAbsolute),
      ShowOverlay: fn(overlayTable, OVERLAY_FNS, 'ShowOverlay', P.HandleOnly),
      HideOverlay: fn(overlayTable, OVERLAY_FNS, 'HideOverlay', P.HandleOnly),
      IsOverlayVisible: fn(overlayTable, OVERLAY_FNS, 'IsOverlayVisible', P.HandleBool),
      SetOverlayTexture: fn(overlayTable, OVERLAY_FNS, 'SetOverlayTexture', P.SetTexture),
      GetOverlayErrorNameFromEnum: fn(overlayTable, OVERLAY_FNS, 'GetOverlayErrorNameFromEnum', P.ErrName),
    };
    this.s = {
      PollNextEvent: fn(systemTable, SYSTEM_FNS, 'PollNextEvent', P.PollEvent),
      AcknowledgeQuit_Exiting: fn(systemTable, SYSTEM_FNS, 'AcknowledgeQuit_Exiting', P.Void),
      GetRuntimeVersion: fn(systemTable, SYSTEM_FNS, 'GetRuntimeVersion', P.Str),
      GetDXGIOutputInfo: fn(systemTable, SYSTEM_FNS, 'GetDXGIOutputInfo', P.OutputInfo),
    };
    this.eventBuf = Buffer.alloc(VREVENT_SIZE);
    this.textureDesc = Buffer.alloc(16);
    this.closed = false;
  }

  /** Function-pointer prototypes, declared once per thread (koffi names are global). */
  static protos(koffi) {
    if (!OpenVR._protos) {
      OpenVR._protos = {
        CreateOverlay: koffi.proto('int32 ApexVr_CreateOverlay(const char *key, const char *name, void *handle)'),
        HandleOnly: koffi.proto('int32 ApexVr_HandleOnly(uint64 handle)'),
        HandleBool: koffi.proto('bool ApexVr_HandleBool(uint64 handle)'),
        HandleFloat: koffi.proto('int32 ApexVr_HandleFloat(uint64 handle, float value)'),
        SetFlag: koffi.proto('int32 ApexVr_SetFlag(uint64 handle, int32 flag, bool enabled)'),
        SetAbsolute: koffi.proto('int32 ApexVr_SetAbsolute(uint64 handle, int32 origin, const void *matrix)'),
        SetTexture: koffi.proto('int32 ApexVr_SetTexture(uint64 handle, const void *texture)'),
        OutputInfo: koffi.proto('void ApexVr_OutputInfo(_Out_ int32 *adapterIndex)'),
        ErrName: koffi.proto('const char *ApexVr_ErrName(int32 err)'),
        PollEvent: koffi.proto('bool ApexVr_PollEvent(void *event, uint32 size)'),
        Void: koffi.proto('void ApexVr_Void()'),
        Str: koffi.proto('const char *ApexVr_Str()'),
      };
    }
    return OpenVR._protos;
  }

  /**
   * Connect to the running SteamVR as an overlay application.
   *
   * ONLY call this when SteamVR is already up (the worker checks for
   * vrserver.exe first): an overlay app's init starts SteamVR if it is not
   * running, and a racing driver who has VR switched on but is driving on a
   * monitor tonight must not have SteamVR spring open on them.
   */
  static connect(dllPath) {
    const koffi = require('koffi');
    const lib = koffi.load(dllPath);
    const init = lib.func('intptr_t VR_InitInternal2(_Out_ int32 *err, int32 type, const char *info)');
    const getInterface = lib.func('void *VR_GetGenericInterface(const char *version, _Out_ int32 *err)');
    const describe = lib.func('const char *VR_GetVRInitErrorAsEnglishDescription(int32 err)');
    const shutdown = lib.func('void VR_ShutdownInternal()');

    const err = [0];
    init(err, VR_APPLICATION_OVERLAY, null);
    if (err[0] !== 0) {
      throw new Error(`SteamVR refused the connection: ${describe(err[0]) || `error ${err[0]}`}`);
    }
    const tables = {};
    for (const [key, version] of [
      ['overlay', IVROVERLAY_VERSION],
      ['system', IVRSYSTEM_VERSION],
    ]) {
      const e = [0];
      const table = getInterface(`FnTable:${version}`, e);
      if (e[0] !== 0 || !table) {
        shutdown();
        throw new Error(`SteamVR has no ${version}: ${describe(e[0]) || `error ${e[0]}`}`);
      }
      tables[key] = table;
    }
    const vr = new OpenVR(koffi, lib, tables.overlay, tables.system);
    vr.shutdownFn = shutdown;
    return vr;
  }

  errorName(code) {
    try {
      return this.o.GetOverlayErrorNameFromEnum(code) || `error ${code}`;
    } catch {
      return `error ${code}`;
    }
  }

  check(code, what) {
    if (code !== 0) throw new Error(`${what}: ${this.errorName(code)}`);
  }

  runtimeVersion() {
    try {
      return this.s.GetRuntimeVersion() || '';
    } catch {
      return '';
    }
  }

  /** Create a named overlay and return its handle (a BigInt). */
  createOverlay(key, name) {
    // Read back through raw bytes: a handle is a full uint64 and must not be
    // squeezed through a JS number on the way.
    const out = Buffer.alloc(8);
    this.check(this.o.CreateOverlay(key, name, out), 'CreateOverlay');
    const handle = out.readBigUInt64LE(0);
    // Chromium's bitmaps are premultiplied; without this every soft edge on a
    // widget (rounded corners, text anti-aliasing) blends with a dark fringe.
    this.check(this.o.SetOverlayFlag(handle, OVERLAY_FLAG_PREMULTIPLIED, true), 'SetOverlayFlag');
    return handle;
  }

  destroyOverlay(handle) {
    return this.o.DestroyOverlay(handle);
  }

  setWidth(handle, metres) {
    this.check(this.o.SetOverlayWidthInMeters(handle, metres), 'SetOverlayWidthInMeters');
  }

  setAlpha(handle, alpha) {
    this.check(this.o.SetOverlayAlpha(handle, alpha), 'SetOverlayAlpha');
  }

  /** World-lock the overlay in the SEATED universe. `matrix` is 12 floats, row-major 3×4. */
  setSeatedTransform(handle, matrix) {
    const buf = Buffer.alloc(48);
    for (let i = 0; i < 12; i++) buf.writeFloatLE(matrix[i], i * 4);
    this.check(
      this.o.SetOverlayTransformAbsolute(handle, TRACKING_UNIVERSE_SEATED, buf),
      'SetOverlayTransformAbsolute',
    );
  }

  show(handle) {
    this.check(this.o.ShowOverlay(handle), 'ShowOverlay');
  }

  hide(handle) {
    this.check(this.o.HideOverlay(handle), 'HideOverlay');
  }

  isVisible(handle) {
    return !!this.o.IsOverlayVisible(handle);
  }

  /** The DXGI adapter index the headset is driven from (-1 when unknown). */
  adapterIndex() {
    const out = [-1];
    try {
      this.s.GetDXGIOutputInfo(out);
    } catch {
      return -1;
    }
    return out[0];
  }

  /**
   * Point the overlay at a D3D11 texture (a pointer, as a BigInt). Returns the
   * EVROverlayError code (0 = fine). Texture_t is { void *handle; ETextureType
   * eType; EColorSpace eColorSpace } — 16 bytes on x64; TextureType_DirectX
   * and ColorSpace_Auto are both 0.
   */
  setTexture(handle, texturePtr) {
    this.textureDesc.writeBigUInt64LE(BigInt(texturePtr), 0);
    return this.o.SetOverlayTexture(handle, this.textureDesc);
  }

  /** Drain pending events; returns true if SteamVR asked us to quit. */
  pollQuit() {
    let quit = false;
    for (let n = 0; n < 64 && this.s.PollNextEvent(this.eventBuf, VREVENT_SIZE); n++) {
      if (this.eventBuf.readUInt32LE(0) === EVENT_QUIT) quit = true;
    }
    return quit;
  }

  /** Tell SteamVR we heard the quit and are leaving, so it does not wait on us. */
  acknowledgeQuit() {
    try {
      this.s.AcknowledgeQuit_Exiting();
    } catch {
      /* best effort */
    }
  }

  shutdown() {
    if (this.closed) return;
    this.closed = true;
    try {
      this.shutdownFn();
    } catch {
      /* best effort */
    }
  }
}

module.exports = {
  OpenVR,
  runtimeDllPath,
  IVROVERLAY_VERSION,
  IVRSYSTEM_VERSION,
  OVERLAY_FNS,
  SYSTEM_FNS,
  VREVENT_SIZE,
};
