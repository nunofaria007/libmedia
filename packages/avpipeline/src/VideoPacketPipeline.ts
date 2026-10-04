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
      heldPacket: null
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
          try {
            const result = await this.pullPacket(task)
            this.replyPacket(task, request, result)
          }
          catch (e) {
            logger.error(`VideoPacketPipeline pull error: ${e}`)
            rightIPCPort.reply(request, IOError.END)
          }
          break
        }
        case 'requestKeyframe': {
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

      const raw = await task.leftIPCPort.request<pointer<AVPacketRef> | AVPacketSerialize | number>('pull')
      if (is.number(raw)) {
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
    if (isPointer(packet) || !task.isH264AnnexB || !task.h264FixPipeline) {
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

    task.outputChunks = []
    task.h264FixPipeline.push(au)

    const prevHeldPacket = task.heldPacket
    if (task.h264FixPipeline.hasHeld) {
      task.heldPacket = serialized
    }
    else {
      task.heldPacket = null
    }

    if (task.outputChunks.length === 0) {
      return null
    }

    const firstChunk = task.outputChunks[0]
    const basePacket = prevHeldPacket || serialized

    basePacket.data = firstChunk.data
    if (firstChunk.key || firstChunk.idr) {
      basePacket.flags |= AVPacketFlags.AV_PKT_FLAG_KEY
    }

    if (task.outputChunks.length > 1) {
      for (let i = 1; i < task.outputChunks.length; i++) {
        const extraChunk = task.outputChunks[i]
        const extraPacket: AVPacketSerialize = {
          ...serialized,
          data: extraChunk.data,
          flags: (extraChunk.key || extraChunk.idr)
            ? (serialized.flags | AVPacketFlags.AV_PKT_FLAG_KEY)
            : serialized.flags
        }
        task.packetCaches.push(extraPacket)
      }
    }

    return basePacket
  }

  private replyPacket(task: SelfTask, request: RpcMessage, packet: pointer<AVPacketRef> | AVPacketSerialize | number) {
    if (is.number(packet)) {
      task.rightIPCPort.reply(request, packet)
      return
    }

    if (!isPointer(packet)) {
      const data = packet as AVPacketSerialize
      const transfer: Transferable[] = []
      if (data.data?.buffer) {
        transfer.push(data.data.buffer)
      }
      if (data.sideData?.length) {
        data.sideData.forEach((side) => {
          if (side.data?.buffer) {
            transfer.push(side.data.buffer)
          }
        })
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
