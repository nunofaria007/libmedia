// Fragment shader for WebGPUExternalRender
// Traditional bob deinterlacer: the selected field (deint.field: 0 = even rows,
// 1 = odd rows) is stretched to full height with linear interpolation.
// Two texture samples per pixel.
//
// `sampleAlpha` (and the aTexture binding when alpha is used) is prepended
// from WebGPUExternalRender.ts before this source is compiled.

struct Deint {
  field: u32,
  pad0: u32,
  pad1: u32,
  pad2: u32,
}

@group(0) @binding(1) var eTexture: texture_external;
@group(0) @binding(2) var s: sampler;
@group(0) @binding(4) var<uniform> deint: Deint;

@fragment
fn main(@location(0) in_texcoord: vec4<f32>) -> @location(0) vec4<f32> {
  let h = i32(textureDimensions(eTexture).y);
  let p = i32(deint.field);

  // last row that belongs to this field
  let lastRow = select(h - 2, h - 1, ((h - 1) & 1) == p);
  let maxJ = f32((lastRow - p) / 2);

  // position in field lines, then the two field rows around it
  let j = clamp((in_texcoord.y * f32(h) - f32(p) - 0.5) * 0.5, 0.0, maxJ);
  let j0 = floor(j);
  let w = j - j0;
  let r0 = 2 * i32(j0) + p;
  let r1 = min(r0 + 2, lastRow);

  let c0 = textureSampleBaseClampToEdge(eTexture, s, vec2<f32>(in_texcoord.x, (f32(r0) + 0.5) / f32(h)));
  let c1 = textureSampleBaseClampToEdge(eTexture, s, vec2<f32>(in_texcoord.x, (f32(r1) + 0.5) / f32(h)));
  let c = mix(c0, c1, w);

  return vec4<f32>(c.rgb, sampleAlpha(in_texcoord.xy, c.a));
}
