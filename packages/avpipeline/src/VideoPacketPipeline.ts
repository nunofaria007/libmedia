/*
 * libmedia VideoPacketPipeline
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

import {
  type RpcMessage,
  IPCPort,
  REQUEST,
  NOTIFY
} from '@libmedia/common/network'

import {
  type AVPacketSerialize,
  type AVPacketRef,
  type AVPacketPool,
  AVPacketPoolImpl,
  AVPacketFlags,
  NOPTS_VALUE_BIGINT
} from '@libmedia/avutil'

import {
  isPointer,
  type Mutex,
  type List
} from '@libmedia/cheap'

import {
  is,
  logger
} from '@libmedia/common'

import {
  IOError
} from '@libmedia/common/io'

import type { TaskOptions } from './Pipeline'
import Pipeline from './Pipeline'

import {
  FixPipeline,
  AccessUnit,
  splitAnnexB,
  nalType,
  sliceInfo,
  hasRecoverySei,
  type OutputChunk
} from './h264fix'

/** Key frames the fix pipeline may see without usable in-band SPS/PPS before it gives up and passes everything through. */
const MAX_KEY_FRAMES_WITHOUT_PARAMS = 3
/** A timestamp step larger than this (1 s at 90 kHz) is a discontinuity. */
const JUMP_TICKS = 22500n
/** Steps this large are the 33-bit PES timestamp wrapping around, not a discontinuity. */
const WRAP_GUARD_TICKS = 1n << 32n

export interface VideoPacketTaskOptions extends TaskOptions {
  avpacketList?: pointer<List<pointer<AVPacketRef>>>
  avpacketListMutex?: pointer<Mutex>
  isH264AnnexB?: boolean
  fixes?: Record<string, boolean>
}

type SelfTask = VideoPacketTaskOptions & {
  packetLogged?: boolean,
  leftIPCPort: IPCPort
  rightIPCPort: IPCPort
  avpacketPool?: AVPacketPool
  packetCaches: (pointer<AVPacketRef> | AVPacketSerialize)[]
  h264FixPipeline?: FixPipeline
  heldPacket?: AVPacketSerialize | null
  outputChunks: OutputChunk[]
  /** Set when the pipeline cannot start on this stream (no usable in-band SPS/PPS): packets pass through untouched. */
  h264Bypass?: boolean
  keyFramesWithoutParams: number
  /** An end-of-stream code waiting behind packets flushed out of the pipeline. */
  pendingEnd?: number
  /** Timestamp of the previous packet, used to spot jumps (queue cropping by the jitter buffer, seeks). */
  lastTs?: bigint | null
}

export default class VideoPacketPipeline extends Pipeline {

  declare tasks: Map<string, SelfTask>

  constructor() {
    super()
  }

  public async registerTask(options: VideoPacketTaskOptions): Promise<number> {
    assert(options.leftPort)
    assert(options.rightPort)

    const leftIPCPort = new IPCPort(options.leftPort)
    const rightIPCPort = new IPCPort(options.rightPort)

    const outputChunks: OutputChunk[] = []
    const task: SelfTask = {
      ...options,
      leftIPCPort,
      rightIPCPort,
      packetCaches: [],
      outputChunks,
      heldPacket: null,
      keyFramesWithoutParams: 0,
      lastTs: null
    }

    if (options.isH264AnnexB) {
      // By default, enable the 3 must-have fixes: fieldPair, idrConvert, mmco
      const defaultFixes: Record<string, boolean> = {
        fieldPair: true,
        idrConvert: true,
        mmco: true
      }
      const fixes = options.fixes ? { ...defaultFixes, ...options.fixes } : defaultFixes
      task.h264FixPipeline = new FixPipeline({
        fixes,
        log: (msg) => logger.info(`[VideoPacketPipeline h264fix] ${msg}`),
        onUnit: (chunk) => {
          task.outputChunks.push(chunk)
        }
      })
    }

    if (options.avpacketList && options.avpacketListMutex) {
      task.avpacketPool = new AVPacketPoolImpl(accessof(options.avpacketList), options.avpacketListMutex)
    }

    // Bidirectional notification forwarding
    leftIPCPort.on(NOTIFY, (msg: RpcMessage) => {
      if (!rightIPCPort.closed) {
        rightIPCPort.notify(msg.method, msg.params)
      }
    })

    rightIPCPort.on(NOTIFY, (msg: RpcMessage) => {
      if (!leftIPCPort.closed) {
        leftIPCPort.notify(msg.method, msg.params)
      }
    })

    // Listen for requests from the consumer side (VideoDecodePipeline)
    rightIPCPort.on(REQUEST, async (request: RpcMessage) => {
      switch (request.method) {
        case 'pull': {
          // A packet that cannot be sent (see replyPacket) is skipped and the next one is tried; only repeated failures end the stream
          let sent = false
          for (let attempt = 0; attempt < 3 && !sent; attempt++) {
            try {
              const result = await this.pullPacket(task)
              this.replyPacket(task, request, result)
              sent = true
            }
            catch (e) {
              logger.error(`VideoPacketPipeline pull error (attempt ${attempt + 1}): ${e}`)
            }
          }
          if (!sent) {
            rightIPCPort.reply(request, IOError.END)
          }
          break
        }
        case 'requestKeyframe': {
          // The decoder lost sync and waits for a key frame: the next join point needs IDR conversion again
          this.restartFixes(task)
          try {
            const res = await leftIPCPort.request('requestKeyframe')
            rightIPCPort.reply(request, res)
          }
          catch (e) {
            rightIPCPort.reply(request, undefined)
          }
          break
        }
        default: {
          try {
            const res = await leftIPCPort.request(request.method, request.params, [])
            rightIPCPort.reply(request, res)
          }
          catch (e) {
            rightIPCPort.reply(request, undefined, { error: e?.message || 'request failed' })
          }
          break
        }
      }
    })

    this.tasks.set(options.taskId, task)
    return 0
  }

  protected async pullPacket(task: SelfTask): Promise<pointer<AVPacketRef> | AVPacketSerialize | number> {
    while (true) {
      if (task.packetCaches.length > 0) {
        return task.packetCaches.shift()!
      }

      if (task.pendingEnd !== undefined) {
        const end = task.pendingEnd
        task.pendingEnd = undefined
        return end
      }

      const raw = await task.leftIPCPort.request<pointer<AVPacketRef> | AVPacketSerialize | number>('pull')
      if (is.number(raw)) {
        if (raw === IOError.END) {
          // A first field may still be waiting for its second field: send it before the end code
          const tail = this.flushHeld(task)
          if (tail.length) {
            task.packetCaches.push(...tail.slice(1))
            task.pendingEnd = raw
            return tail[0]
          }
        }
        return raw
      }

      const processed = await this.processPacket(task, raw)
      if (processed !== null) {
        return processed
      }

      // If packet was dropped by processPacket, release it if pointer and pool available
      if (isPointer(raw) && task.avpacketPool) {
        task.avpacketPool.release(raw as unknown as pointer<AVPacketRef>)
      }
    }
  }

  /**
   * Extensible packet processing hook.
   * Applies h264 fixes (fieldPair, idrConvert, mmco) to serialized packets.
   * If packet is pointer<AVPacketRef>, passes through as-is for the wasm decoder.
   * 
   * @param task Current task
   * @param packet The packet from Demuxer (pointer or serialized object)
   * @returns Processed packet, or null to drop packet and pull next
   */
  public async processPacket(
    task: SelfTask,
    packet: pointer<AVPacketRef> | AVPacketSerialize
  ): Promise<pointer<AVPacketRef> | AVPacketSerialize | null> {
    if (!task.packetLogged) {
      task.packetLogged = true
      logger.info( `VideoPacketPipeline first packet: ${isPointer(packet) ? 'pointer<AVPacketRef>' : 'AVPacketSerialize'}, `
      + `annexB H.264: ${!!task.isH264AnnexB} (${task.isH264AnnexB ? 'processing enabled' : 'passthrough'}), `
      + `taskId: ${task.taskId}`)
    }

    // Ignore pointer<AVPacketRef>, pass through as-is for ffmpeg wasm decoder
    if (isPointer(packet) || !task.isH264AnnexB || !task.h264FixPipeline || task.h264Bypass) {
      return packet
    }

    const serialized = packet as AVPacketSerialize
    if (!serialized.data || serialized.data.length === 0) {
      return packet
    }

    const nals = splitAnnexB(serialized.data)
    if (!nals.length) {
      return packet
    }

    const pipeline = task.h264FixPipeline

    const au = new AccessUnit()
    au.nals = nals
    au.pts = serialized.pts !== NOPTS_VALUE_BIGINT ? Number(serialized.pts) : undefined

    for (const n of nals) {
      const t = nalType(n)
      if (t === 6 && hasRecoverySei(n)) {
        au.rp = true
      }
      if ((t === 1 || t === 5) && !au.vcl) {
        au.vcl = true
        au.vclNal = n
        au.idr = t === 5
        try {
          const si = sliceInfo(n)
          au.isI = si.type === 2 || si.type === 4
        }
        catch (e) {
          // ignore error
        }
      }
    }

    // A timestamp jump means packets were skipped (jitter buffer cropping, seek): the decoder resumes at an arbitrary key frame,
    // which in an open GOP is followed by pictures that reference the skipped ones. Treat it as a new start.
    const ts = serialized.dts !== NOPTS_VALUE_BIGINT && serialized.dts >= 0n ? serialized.dts : serialized.pts
    if (ts !== NOPTS_VALUE_BIGINT && ts >= 0n) {
      if (task.lastTs !== null && task.lastTs !== undefined) {
        const d = ts > task.lastTs ? ts - task.lastTs : task.lastTs - ts
        // Differences near 2^33 are the 33-bit timestamp wrap, not a jump
        if (d > JUMP_TICKS && d < WRAP_GUARD_TICKS) {
          logger.warn(`[VideoPacketPipeline h264fix] timestamp jump of ${d} ticks, restarting fixes at this packet`)
          this.restartFixes(task)
        }
      }
      task.lastTs = ts
    }

    // Extra packets are derived from the packet as it arrived, before it is modified below
    const original: AVPacketSerialize = { ...serialized }

    task.outputChunks = []
    pipeline.push(au)

    // The pipeline needs an SPS and PPS it can parse, seen in band. If key frames keep arriving without them (parameter sets
    // only in the codec extradata, or an unsupported PPS) it never starts and would drop the whole video: pass through instead.
    if (!pipeline.ctx.started && au.isKey && (!pipeline.spsInfo || !pipeline.pps)) {
      task.keyFramesWithoutParams++
      if (task.keyFramesWithoutParams >= MAX_KEY_FRAMES_WITHOUT_PARAMS) {
        task.h264Bypass = true
        task.heldPacket = null
        logger.warn('[VideoPacketPipeline h264fix] no usable in-band SPS/PPS on key frames, fixes disabled for this stream')
        return packet
      }
    }

    const prevHeldPacket = task.heldPacket
    const holdNow = pipeline.hasHeld

    const chunks = task.outputChunks
    if (chunks.length === 0) {
      task.heldPacket = holdNow ? serialized : null
      return null
    }

    // The first chunk belongs to the packet that was held (first field) or to this packet; any further chunk to this packet
    const basePacket = prevHeldPacket || serialized
    // If this packet is sent now and is also the first field kept for pairing, the two must not share buffers: sending one
    // transfers (detaches) them. Keep a separate copy as the held packet.
    task.heldPacket = holdNow ? (basePacket === serialized ? this.derivePacket(original) : serialized) : null
    const out = chunks.map((chunk, i) => this.applyChunk(i === 0 ? basePacket : this.derivePacket(original), chunk))
    if (out.length > 1) {
      task.packetCaches.push(...out.slice(1))
    }
    return out[0]
  }

  /** Writes a pipeline chunk into a packet. Data is only replaced when the chunk differs from what the packet carried. */
  private applyChunk(packet: AVPacketSerialize, chunk: OutputChunk): AVPacketSerialize {
    if (chunk.changed) {
      packet.data = chunk.data
    }
    if (chunk.key || chunk.idr) {
      packet.flags |= AVPacketFlags.AV_PKT_FLAG_KEY
    }
    return packet
  }

  /** Copy of a packet that can be sent on its own: replyPacket transfers buffers, so neither data nor side data may be shared. */
  private derivePacket(packet: AVPacketSerialize): AVPacketSerialize {
    return {
      ...packet,
      data: packet.data?.slice(),
      sideData: packet.sideData?.map((side) => ({ ...side, data: side.data?.slice() }))
    }
  }

  /** Pushes out a first field that is still waiting for its second field (end of stream). */
  private flushHeld(task: SelfTask): AVPacketSerialize[] {
    const pipeline = task.h264FixPipeline
    const held = task.heldPacket
    if (!pipeline || !held || !pipeline.hasHeld) {
      return []
    }
    task.heldPacket = null
    task.outputChunks = []
    pipeline.flush()
    return task.outputChunks.map((chunk, i) => this.applyChunk(i === 0 ? held : this.derivePacket(held), chunk))
  }

  /** Forgets the start state of the fixes: the next key frame is converted and its leading pictures dropped, as at stream start. */
  private restartFixes(task: SelfTask) {
    if (task.h264FixPipeline) {
      task.h264FixPipeline.restart()
    }
    task.heldPacket = null
    task.outputChunks = []
    task.lastTs = null
  }

  private replyPacket(task: SelfTask, request: RpcMessage, packet: pointer<AVPacketRef> | AVPacketSerialize | number) {
    if (is.number(packet)) {
      task.rightIPCPort.reply(request, packet)
      return
    }

    if (!isPointer(packet)) {
      const data = packet as AVPacketSerialize
      const transfer: Transferable[] = []
      const add = (u8?: Uint8Array) => {
        const buffer = u8?.buffer
        if (buffer && buffer.byteLength > 0 && !transfer.includes(buffer)) {
          transfer.push(buffer)
        }
        return !!buffer && buffer.byteLength === 0 && !!u8 && u8.byteLength === 0 && u8.length === 0
      }
      const detachedData = add(data.data)
      const detachedSide = (data.sideData || []).filter((side) => add(side.data)).length
      if (detachedData || detachedSide) {
        logger.error(`[VideoPacketPipeline] packet buffers already transferred (data: ${detachedData}, sideData: ${detachedSide}), `
          + `pts: ${data.pts}, dts: ${data.dts}, flags: ${data.flags}`)
      }
      task.rightIPCPort.reply(request, data, null, transfer)
      return
    }

    task.rightIPCPort.reply(request, packet)
  }

  public async resetTask(taskId: string) {
    const task = this.tasks.get(taskId)
    if (task) {
      if (task.packetCaches.length) {
        task.packetCaches.forEach((pkt) => {
          if (isPointer(pkt) && task.avpacketPool) {
            task.avpacketPool.release(pkt as unknown as pointer<AVPacketRef>)
          }
        })
        task.packetCaches.length = 0
      }
      if (task.h264FixPipeline) {
        task.h264FixPipeline.restart()
      }
      task.heldPacket = null
      task.outputChunks = []
      task.pendingEnd = undefined
      task.lastTs = null
      task.h264Bypass = false
      task.keyFramesWithoutParams = 0
    }
  }

  public async unregisterTask(taskId: string): Promise<void> {
    const task = this.tasks.get(taskId)
    if (task) {
      await this.resetTask(taskId)
      task.leftIPCPort.destroy()
      task.rightIPCPort.destroy()
      this.tasks.delete(taskId)
    }
  }
}
