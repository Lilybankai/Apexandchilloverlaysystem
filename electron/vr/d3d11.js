/**
 * electron/vr/d3d11.js — a GPU texture SteamVR can draw the panel from.
 * -----------------------------------------------------------------------------
 * ## Why not SetOverlayRaw
 *
 * The plan's Phase 1 prototype path was SetOverlayRaw: hand SteamVR the CPU
 * pixels and let it upload them. Measured on SteamVR 2.17.10 (2026-09-28), it
 * is not "flaky over long runs" as reported elsewhere — it stops dead. Every
 * connection gets exactly 201 successful calls, then VROverlayError_
 * RequestFailed on every call after, whatever the image size (256×128 and
 * 1340×450 alike), with or without ClearOverlayTexture between them, and even
 * on a freshly created overlay. At 15 fps that is thirteen seconds of panel.
 *
 * So the pixels go through Direct3D 11 instead, which is what the plan had
 * down for Phase 3: we own a D3D11 device on the same GPU as the headset,
 * copy each painted frame into a texture with UpdateSubresource, and pass the
 * texture itself to SetOverlayTexture. The compositor opens it through its
 * shared handle, which is why it is created D3D11_RESOURCE_MISC_SHARED.
 *
 * ## Why no native addon
 *
 * Every call here is a plain exported function (D3D11CreateDevice,
 * CreateDXGIFactory1) or a COM vtable slot, and koffi calls both — the same
 * way electron/gamepad.js drives DirectInput. The vtable indices below come
 * from the Windows SDK's d3d11.h / dxgi.h (10.0.26100.0); COM vtables never
 * reorder, so they hold on every Windows version.
 *
 * ## Tearing
 *
 * Two textures, alternated: the compositor samples the panel at the headset's
 * refresh rate, and writing into the texture it is sampling could show half a
 * frame. Each upload goes into the one it is NOT drawing, then that one is
 * handed over.
 *
 * Chromium paints BGRA, and the textures are B8G8R8A8, so the bytes go in
 * exactly as painted — no per-pixel conversion anywhere.
 */

'use strict';

const DXGI_FORMAT_B8G8R8A8_UNORM = 87;
const D3D11_USAGE_DEFAULT = 0;
const D3D11_BIND_SHADER_RESOURCE = 0x8;
const D3D11_RESOURCE_MISC_SHARED = 0x2;
const D3D11_CREATE_DEVICE_BGRA_SUPPORT = 0x20;
const D3D_DRIVER_TYPE_UNKNOWN = 0;
const D3D_DRIVER_TYPE_HARDWARE = 1;
const D3D11_SDK_VERSION = 7;

/* COM vtable slots (d3d11.h / dxgi.h). */
const SLOT = {
  Release: 2,
  // IDXGIFactory1: IUnknown(3) + IDXGIObject(4) + IDXGIFactory(5), then EnumAdapters1.
  EnumAdapters1: 12,
  // ID3D11Device
  CreateTexture2D: 5,
  // ID3D11DeviceContext
  UpdateSubresource: 48,
  Flush: 111,
};

/** IID_IDXGIFactory1 {770aae78-f26f-4dba-a829-253c83d1b387}, as the GUID struct's bytes. */
function iidDxgiFactory1() {
  const b = Buffer.alloc(16);
  b.writeUInt32LE(0x770aae78, 0);
  b.writeUInt16LE(0xf26f, 4);
  b.writeUInt16LE(0x4dba, 6);
  Buffer.from([0xa8, 0x29, 0x25, 0x3c, 0x83, 0xd1, 0xb3, 0x87]).copy(b, 8);
  return b;
}

let P = null;
function protos(koffi) {
  if (!P) {
    P = {
      Release: koffi.proto('uint32 __stdcall ApexD3d_Release(void *self)'),
      EnumAdapters1: koffi.proto('int32 __stdcall ApexD3d_EnumAdapters1(void *self, uint32 index, _Out_ void **adapter)'),
      CreateTexture2D: koffi.proto(
        'int32 __stdcall ApexD3d_CreateTexture2D(void *self, const void *desc, const void *init, _Out_ void **texture)',
      ),
      UpdateSubresource: koffi.proto(
        'void __stdcall ApexD3d_UpdateSubresource(void *self, void *resource, uint32 sub, const void *box, const void *src, uint32 rowPitch, uint32 depthPitch)',
      ),
      Flush: koffi.proto('void __stdcall ApexD3d_Flush(void *self)'),
    };
  }
  return P;
}

class D3DPanelTextures {
  /**
   * @param {number} adapterIndex DXGI adapter the headset is on (from
   *   IVRSystem::GetDXGIOutputInfo); anything below 0 means "the default".
   */
  constructor(adapterIndex) {
    const koffi = require('koffi');
    this.koffi = koffi;
    this.P = protos(koffi);
    const d3d = koffi.load('d3d11.dll');
    const createDevice = d3d.func(
      'int32 __stdcall D3D11CreateDevice(void *adapter, int32 driverType, void *software, uint32 flags, void *levels, uint32 nLevels, uint32 sdk, _Out_ void **device, _Out_ int32 *level, _Out_ void **context)',
    );

    // The texture must live on the GPU the compositor runs on, or SteamVR
    // cannot open it — which matters on a laptop with integrated + discrete.
    let adapter = null;
    if (adapterIndex >= 0) {
      try {
        const dxgi = koffi.load('dxgi.dll');
        const createFactory = dxgi.func('int32 __stdcall CreateDXGIFactory1(const void *riid, _Out_ void **factory)');
        const f = [null];
        if (createFactory(iidDxgiFactory1(), f) === 0 && f[0]) {
          const a = [null];
          if (this.com(f[0], 'EnumAdapters1', adapterIndex, a) === 0) adapter = a[0];
          this.com(f[0], 'Release');
        }
      } catch {
        adapter = null; // fall back to the default adapter below
      }
    }

    const dev = [null];
    const lvl = [0];
    const ctx = [null];
    const hr = createDevice(
      adapter,
      adapter ? D3D_DRIVER_TYPE_UNKNOWN : D3D_DRIVER_TYPE_HARDWARE,
      null,
      D3D11_CREATE_DEVICE_BGRA_SUPPORT,
      null,
      0,
      D3D11_SDK_VERSION,
      dev,
      lvl,
      ctx,
    );
    if (adapter) this.com(adapter, 'Release');
    if (hr !== 0 || !dev[0] || !ctx[0]) {
      throw new Error(`Direct3D 11 device could not be created (0x${(hr >>> 0).toString(16)})`);
    }
    this.device = dev[0];
    this.context = ctx[0];
    this.textures = [];
    this.width = 0;
    this.height = 0;
    this.next = 0;
  }

  /** Call a COM method by vtable slot name. */
  com(obj, name, ...args) {
    const vtbl = this.koffi.decode(obj, 'void*');
    const fn = this.koffi.decode(vtbl, SLOT[name] * 8, 'void*');
    return this.koffi.call(fn, this.P[name], obj, ...args);
  }

  /** (Re)create the pair of textures when the panel's pixel size changes. */
  ensureSize(width, height) {
    if (width === this.width && height === this.height && this.textures.length === 2) return;
    this.releaseTextures();
    const desc = Buffer.alloc(44);
    const fields = [
      width,
      height,
      1, // MipLevels
      1, // ArraySize
      DXGI_FORMAT_B8G8R8A8_UNORM,
      1, // SampleDesc.Count
      0, // SampleDesc.Quality
      D3D11_USAGE_DEFAULT,
      D3D11_BIND_SHADER_RESOURCE,
      0, // CPUAccessFlags
      D3D11_RESOURCE_MISC_SHARED,
    ];
    fields.forEach((v, i) => desc.writeUInt32LE(v, i * 4));
    for (let i = 0; i < 2; i++) {
      const out = [null];
      const hr = this.com(this.device, 'CreateTexture2D', desc, null, out);
      if (hr !== 0 || !out[0]) {
        this.releaseTextures();
        throw new Error(`panel texture could not be created (0x${(hr >>> 0).toString(16)})`);
      }
      this.textures.push(out[0]);
    }
    this.width = width;
    this.height = height;
    this.next = 0;
  }

  /**
   * Copy one BGRA frame into the texture the compositor is not drawing, and
   * return that texture's pointer as a BigInt for SetOverlayTexture.
   */
  upload(bgra, width, height) {
    this.ensureSize(width, height);
    const tex = this.textures[this.next];
    this.next ^= 1;
    this.com(this.context, 'UpdateSubresource', tex, 0, null, bgra, width * 4, 0);
    // Submit now: the compositor reads the texture from its own device, and
    // an unflushed copy would still be sitting in our command queue.
    this.com(this.context, 'Flush');
    return this.koffi.address(tex);
  }

  releaseTextures() {
    for (const t of this.textures) {
      try {
        this.com(t, 'Release');
      } catch {
        /* best effort */
      }
    }
    this.textures = [];
    this.width = 0;
    this.height = 0;
  }

  release() {
    this.releaseTextures();
    for (const obj of [this.context, this.device]) {
      if (!obj) continue;
      try {
        this.com(obj, 'Release');
      } catch {
        /* best effort */
      }
    }
    this.context = null;
    this.device = null;
  }
}

module.exports = { D3DPanelTextures };
