// Fragment shader for WebGPUExternalRender
// Bob deinterlacer (one output picture per field) with optional ELA interpolation.
//
// For the field being shown (deint.field: 0 = even rows / top, 1 = odd rows / bottom):
//   - rows that belong to the field are kept untouched (full sharpness)
//   - the missing rows are interpolated from that same field only, so no output
//     picture ever mixes two moments in time (no combing, no ghosting)
//
// Set USE_ELA to false for plain linear bob (vertical average of the field lines).
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

const USE_ELA: bool = true;
const ELA_RADIUS: i32 = 3;
const ELA_MARGIN: f32 = 0.04;  // a diagonal must beat vertical by this much to be used

fn tap(x: i32, y: i32, dims: vec2<i32>) -> vec3<f32> {
  let p = vec2<f32>(f32(clamp(x, 0, dims.x - 1)), f32(clamp(y, 0, dims.y - 1))) + vec2<f32>(0.5);
  return textureSampleBaseClampToEdge(eTexture, s, p / vec2<f32>(dims)).rgb;
}

fn luma(c: vec3<f32>) -> f32 {
  return dot(c, vec3<f32>(0.2126, 0.7152, 0.0722));
}

// colour of row y of the deinterlaced field picture at integer position x
fn fieldTexel(x: i32, yIn: i32, dims: vec2<i32>) -> vec3<f32> {
  let y = clamp(yIn, 0, dims.y - 1);
  if ((u32(y) & 1u) == deint.field) {
    return tap(x, y, dims);
  }

  // nearest rows of the same field above / below (stay inside the picture)
  let yu = select(y - 1, y + 1, y - 1 < 0);
  let yd = select(y + 1, y - 1, y + 1 >= dims.y);

  let up = tap(x, yu, dims);
  let dn = tap(x, yd, dims);
  var result = (up + dn) * 0.5;

  if (USE_ELA) {
    var ucol: array<vec3<f32>, 9>;
    var dcol: array<vec3<f32>, 9>;
    var ul: array<f32, 9>;
    var dl: array<f32, 9>;
    for (var i = 0; i < 9; i++) {
      ucol[i] = tap(x + i - 4, yu, dims);
      dcol[i] = tap(x + i - 4, yd, dims);
      ul[i] = luma(ucol[i]);
      dl[i] = luma(dcol[i]);
    }

    // vertical cost (3-pixel window), then diagonals that clearly beat it
    var best = abs(ul[3] - dl[3]) + abs(ul[4] - dl[4]) + abs(ul[5] - dl[5]);
    for (var d = -ELA_RADIUS; d <= ELA_RADIUS; d++) {
      if (d == 0) {
        continue;
      }
      var cost = 0.0;
      for (var k = -1; k <= 1; k++) {
        cost += abs(ul[4 + d + k] - dl[4 - d + k]);
      }
      if (cost + ELA_MARGIN < best) {
        best = cost;
        result = (ucol[4 + d] + dcol[4 - d]) * 0.5;
      }
    }
  }
  return result;
}

@fragment
fn main(@location(0) in_texcoord: vec4<f32>) -> @location(0) vec4<f32> {
  let dims = vec2<i32>(textureDimensions(eTexture));
  let src = textureSampleBaseClampToEdge(eTexture, s, in_texcoord.xy);

  // manual bilinear over the field picture, identical to linear filtering
  // when the canvas is scaled and exact when it is 1:1
  let t = in_texcoord.xy * vec2<f32>(dims) - vec2<f32>(0.5);
  let p = vec2<i32>(floor(t));
  let f = fract(t);

  let c00 = fieldTexel(p.x,     p.y,     dims);
  let c10 = fieldTexel(p.x + 1, p.y,     dims);
  let c01 = fieldTexel(p.x,     p.y + 1, dims);
  let c11 = fieldTexel(p.x + 1, p.y + 1, dims);
  let color = mix(mix(c00, c10, f.x), mix(c01, c11, f.x), f.y);

  return vec4<f32>(color, sampleAlpha(in_texcoord.xy, src.a));
}
