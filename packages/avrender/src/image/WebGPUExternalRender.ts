/*
 * libmedia WebGPUExternalRender
 *
 * 版权所有 (C) 2024 赵高兴 
 * Copyright (C) 2024 Gaoxing Zhao
 *
 * 此文件是 libmedia 的一部分 
 * This file is part of libmedia.
 *
 * libmedia 是自由软件；您可以根据 GNU Lesser General Public License（GNU LGPL）3.1
 * 或任何其更新的版本条款重新分发或修改它 
 * libmedia is free software; you can redistribute it and/or
 * modify it under the terms of the GNU Lesser General Public
 * License as published by the Free Software Foundation; either
 * version 3.1 of the License, or (at your option) any later version.
 *
 * libmedia 希望能够为您提供帮助，但不提供任何明示或暗示的担保，包括但不限于适销性或特定用途的保证 
 * 您应自行承担使用 libmedia 的风险，并且需要遵守 GNU Lesser General Public License 中的条款和条件。
 * libmedia is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU
 * Lesser General Public License for more details.
 *
 */

import vertexSource from './webgpu/wgsl/vertex.wgsl'
import fragmentSource from './webgpu/wgsl/external3.wgsl'
import type { WebGPURenderOptions } from './WebGPURender'
import WebGPURender from './WebGPURender'

import {
  type AVFrame
} from '@libmedia/avutil'

const HDRPrimaries = ['bt2020', 'bt2100', 'st2048', 'p3-dcl', 'hlg']

// alpha-dependent declarations, prepended to external.wgsl
// (external.wgsl declares `s` and calls sampleAlpha)
const ALPHA_SNIPPET = `
@group(0) @binding(3) var aTexture: texture_external;

fn sampleAlpha(uv: vec2<f32>, a: f32) -> f32 {
  return textureSampleBaseClampToEdge(aTexture, s, uv).r;
}
`

const NO_ALPHA_SNIPPET = `
fn sampleAlpha(uv: vec2<f32>, a: f32) -> f32 {
  return a;
}
`

export default class WebGPUExternalRender extends WebGPURender {

  private hasAlpha: boolean

  /**
   * Field order of the source. true = top field first (most 1080i / 576i broadcast),
   * false = bottom field first (e.g. DV).
   */
  public topFieldFirst = true

  private deintBuffer: GPUBuffer | null = null

  // bob state: the second field of a frame is drawn half a frame later
  private pendingTimer: ReturnType<typeof setTimeout> | null = null
  private pendingFrame: VideoFrame | null = null
  private pendingAlpha: VideoFrame | null = null
  private lastTimestamp = -1
  private lastDuration = 0

  constructor(canvas: HTMLCanvasElement | OffscreenCanvas, options: WebGPURenderOptions) {
    super(canvas, options)
    this.vertexSource = vertexSource
  }

  private generateFragmentSource() {
    this.fragmentSource = (this.hasAlpha ? ALPHA_SNIPPET : NO_ALPHA_SNIPPET) + fragmentSource
  }

  private checkFrame(frame: VideoFrame, alpha?: VideoFrame) {
    const hasAlpha = !!alpha
    if (frame.codedWidth !== this.textureWidth
      || frame.codedHeight !== this.videoHeight
      || frame.codedWidth !== this.videoWidth
      || this.hasAlpha !== hasAlpha
    ) {
      this.videoWidth = frame.codedWidth
      this.videoHeight = frame.codedHeight
      this.textureWidth = frame.codedWidth
      this.hasAlpha = hasAlpha
      this.layout()

      this.generateFragmentSource()

      this.generatePipeline()
    }
  }

  protected generateBindGroup(): void {

    const descriptor: GPUBindGroupLayoutDescriptor = {
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX,
          buffer: {
            type: 'uniform'
          }
        },
        {
          binding: 1,
          visibility: GPUShaderStage.FRAGMENT,
          externalTexture: {
          }
        },
        {
          binding: 2,
          visibility: GPUShaderStage.FRAGMENT,
          sampler: {
            type: 'filtering'
          }
        },
        {
          binding: 4,
          visibility: GPUShaderStage.FRAGMENT,
          buffer: {
            type: 'uniform'
          }
        }
      ]
    }
    if (this.hasAlpha) {
      descriptor.entries.push({
        binding: 3,
        visibility: GPUShaderStage.FRAGMENT,
        externalTexture: {
        }
      })
    }
    this.bindGroupLayout = this.device.createBindGroupLayout(descriptor)
  }

  private cancelPending() {
    if (this.pendingTimer !== null) {
      clearTimeout(this.pendingTimer)
      this.pendingTimer = null
    }
    if (this.pendingFrame) {
      this.pendingFrame.close()
      this.pendingFrame = null
    }
    if (this.pendingAlpha) {
      this.pendingAlpha.close()
      this.pendingAlpha = null
    }
  }

  /**
   * Draw one field (0 = even rows, 1 = odd rows) of the frame, deinterlaced.
   */
  private draw(frame: VideoFrame, alpha: VideoFrame | undefined, field: 0 | 1) {

    this.checkFrame(frame, alpha)

    if (!this.deintBuffer) {
      this.deintBuffer = this.device.createBuffer({
        size: Uint32Array.BYTES_PER_ELEMENT * 4,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
      })
    }
    this.device.queue.writeBuffer(this.deintBuffer, 0, new Uint32Array([field, 0, 0, 0]))

    const descriptor: GPUBindGroupDescriptor = {
      layout: this.renderPipeline.getBindGroupLayout(0),
      entries: [
        {
          binding: 0,
          resource: {
            buffer: this.rotateMatrixBuffer,
            size: Float32Array.BYTES_PER_ELEMENT * 16
          }
        },
        {
          binding: 1,
          resource: this.device.importExternalTexture({
            source: frame
          })
        },
        {
          binding: 2,
          resource: this.sampler
        },
        {
          binding: 4,
          resource: {
            buffer: this.deintBuffer
          }
        }
      ]
    }

    if (alpha) {
      descriptor.entries.push({
        binding: 3,
        resource: this.device.importExternalTexture({
          source: alpha
        })
      })
    }

    const bindGroup = this.device.createBindGroup(descriptor)

    const commandEncoder = this.device.createCommandEncoder()

    const renderPassDescriptor: GPURenderPassDescriptor = {
      colorAttachments: [
        {
          view: this.context.getCurrentTexture().createView(),
          clearValue: {
            r: 0,
            g: 0,
            b: 0,
            a: 0
          },
          loadOp: 'clear',
          storeOp: 'store'
        }
      ]
    }

    const renderPass = commandEncoder.beginRenderPass(renderPassDescriptor)
    renderPass.setPipeline(this.renderPipeline)
    renderPass.setBindGroup(0, bindGroup)
    renderPass.setVertexBuffer(0, this.vbo)
    renderPass.draw(4, 4, 0, 0)
    renderPass.end()
    this.device.queue.submit([commandEncoder.finish()])
  }

  /**
   * Bob deinterlace: every source frame produces two pictures, one per field.
   *
   * - `field` omitted: the first field is drawn now and the second one is drawn
   *   automatically half a frame duration later (double frame rate output).
   * - `field` given (0 or 1): only that field is drawn, so the caller can drive
   *   the double-rate timing itself by calling render() twice per frame.
   */
  public render(frame: VideoFrame, alpha?: VideoFrame, field?: 0 | 1): void {

    if (this.lost) {
      return
    }

    // a new frame always supersedes a second field that has not been shown yet
    this.cancelPending()

    if (field !== undefined) {
      this.draw(frame, alpha, field)
      return
    }

    const first: 0 | 1 = this.topFieldFirst ? 0 : 1
    this.draw(frame, alpha, first)

    // frame duration in microseconds: from the frame itself, else from timestamps
    let duration = frame.duration || 0
    if (!duration && this.lastTimestamp >= 0) {
      const delta = frame.timestamp - this.lastTimestamp
      if (delta > 0 && delta < 200000) {
        duration = delta
      }
    }
    this.lastTimestamp = frame.timestamp
    if (duration) {
      this.lastDuration = duration
    }
    else {
      duration = this.lastDuration
    }
    if (!duration) {
      // no timing information yet, the first field only
      return
    }

    // clone() shares the underlying media resource, it does not copy pixels
    this.pendingFrame = frame.clone()
    this.pendingAlpha = alpha ? alpha.clone() : null

    this.pendingTimer = setTimeout(() => {
      this.pendingTimer = null
      const pendingFrame = this.pendingFrame
      const pendingAlpha = this.pendingAlpha
      this.pendingFrame = null
      this.pendingAlpha = null
      if (pendingFrame) {
        if (!this.lost) {
          this.draw(pendingFrame, pendingAlpha || undefined, first === 0 ? 1 : 0)
        }
        pendingFrame.close()
      }
      if (pendingAlpha) {
        pendingAlpha.close()
      }
    }, duration / 2000)
  }

  static isSupport(frame: pointer<AVFrame> | VideoFrame | ImageBitmap): boolean {
    // VideoFrame
    return frame instanceof VideoFrame && !(HDRPrimaries.some((p) => p === frame.colorSpace.primaries))
  }
}
