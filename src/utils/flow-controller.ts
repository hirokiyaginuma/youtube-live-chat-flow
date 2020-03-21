import error from '~/assets/error.svg'
import Filter from '~/models/filter'
import Settings from '~/models/settings'
import Message from '~/models/message'
import { querySelectorAsync, waitAllImagesLoaded } from './dom-helper'
import MessageSettings from './message-settings'
import { parse } from './message-parser'
import { render } from './message-renderer'

interface Timeline {
  willAppear: number
  didAppear: number
  willDisappear: number
  didDisappear: number
}

export default class FlowController {
  private _enabled = false
  private _following = false
  private timelines: Timeline[][] = []
  private observer: MutationObserver | undefined
  private followingTimer = -1
  private cleanupTimer = -1
  private processTimer = -1
  private processing = false
  private queues: HTMLElement[] = []
  settings: Settings | undefined

  get enabled() {
    return this._enabled
  }

  set enabled(value) {
    this._enabled = value
    if (!this._enabled) {
      this.clear()
    }
  }

  get following() {
    return this._following
  }

  set following(value) {
    this._following = value
    if (value) {
      const scrollToBottom = () => {
        const hovered = !!document.querySelector('#chat:hover')
        if (hovered) {
          return
        }
        const scroller = document.querySelector('#item-scroller')
        if (scroller) {
          scroller.scrollTop = scroller.scrollHeight
        }
      }
      scrollToBottom()
      this.followingTimer = window.setInterval(scrollToBottom, 1000)
    } else {
      clearInterval(this.followingTimer)
    }
  }

  private async flow(element: HTMLElement) {
    if (!this._enabled || !this.settings) {
      return
    }

    const video = parent.document.querySelector(
      'video.html5-main-video'
    ) as HTMLVideoElement | null
    if (!video || video.paused) {
      return
    }

    const container = parent.document.querySelector(
      '.html5-video-container'
    ) as HTMLElement | null
    if (!container) {
      return
    }

    const rows = Number(this.settings.rows)
    const height = video.offsetHeight / (rows + 0.2)

    const message = await parse(element)
    if (!message) {
      return
    }

    const infoIcon = element.querySelector('.ylcf-info-icon')
    infoIcon && infoIcon.remove()

    const reason = this.filterMessage(message, this.settings)
    if (reason) {
      const div = document.createElement('div')
      div.classList.add('ylcf-info-icon')
      div.style.marginTop = '4px'
      div.style.marginRight = '8px'
      div.style.cursor = 'pointer'
      div.title = reason
      div.innerHTML = error
      const svg = div.querySelector('svg') as SVGElement
      svg.style.fill = 'var(--yt-live-chat-secondary-text-color)'
      svg.style.width = '16px'
      element.prepend(div)
      return
    }

    const displays = Number(this.settings.displays)
    const messages = this.getMessages()
    if (displays > 0 && displays <= messages) {
      return
    }

    const me = await this.createMessageElement(message, height, this.settings)
    if (!me) {
      return
    }

    me.style.display = 'none'
    container.appendChild(me)
    await waitAllImagesLoaded(me)
    me.style.display = 'flex'

    const messageRows = Math.ceil(me.offsetHeight / Math.ceil(height))
    const containerWidth = container.offsetWidth
    const timeline = this.createTimeline(me, containerWidth, this.settings)

    const index = this.getIndex(messageRows, timeline, this.settings)
    if (index + messageRows > rows && this.settings.overflow === 'hidden') {
      me.remove()
      return
    }
    this.pushTimeline(timeline, index, messageRows)

    const z = Math.floor(index / rows)
    const y = (index % rows) + (z % 2 > 0 ? 0.5 : 0)
    const opacity = Number(this.settings.opacity) ** (z + 1)
    const top =
      this.settings.stackDirection === 'bottom_to_top'
        ? video.offsetHeight - height * (y + messageRows + 0.1)
        : height * (y + 0.1)

    me.style.top = `${top}px`
    me.style.opacity = String(opacity)
    me.style.zIndex = String(z + 1)

    const animation = this.createAnimation(me, containerWidth, this.settings)
    animation.onfinish = () => {
      me.remove()
    }
    animation.play()
  }

  private async createMessageElement(
    message: Message,
    height: number,
    settings: Settings
  ) {
    const ms = new MessageSettings(message, settings)
    if (!ms.template) {
      return null
    }

    const element = render(ms.template, {
      ...message,
      author: ms.author ? message.author : undefined,
      avatarUrl: ms.avatar ? message.avatarUrl : undefined,
      fontColor: ms.fontColor,
      fontStyle: ms.fontStyle,
      height
    })

    if (!element) {
      return null
    }

    element.classList.add('ylcf-flow-message')

    return element
  }

  private filterMessage(message: Message, settings: Settings) {
    return settings.filters.reduce((carry: string, filter: Filter) => {
      if (carry) {
        return carry
      }

      const { subject, keyword, regExp } = filter
      if (!subject || !keyword) {
        return carry
      }

      let reg
      try {
        const pattern = regExp
          ? keyword
          : keyword.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')

        reg = new RegExp(`(${pattern})`, 'i')
      } catch (e) {
        return carry
      }

      const text = subject === 'author' ? message.author : message.message
      if (!text || !reg.test(text)) {
        return carry
      }

      let reason = `Match keyword "${keyword}" in ${subject}`
      if (regExp) {
        reason += ' with regexp'
      }

      return reason
    }, '')
  }
  private createTimeline(
    element: HTMLElement,
    containerWidth: number,
    settings: Settings
  ) {
    const millis = Number(settings.speed) * 1000
    const w = element.offsetWidth
    const v = (containerWidth + w) / millis
    const t = w / v
    const n = Date.now()

    return {
      willAppear: n,
      didAppear: n + t,
      willDisappear: n + millis - t,
      didDisappear: n + millis
    }
  }

  private createAnimation(
    element: HTMLElement,
    containerWidth: number,
    settings: Settings
  ) {
    const duration = Number(settings.speed) * 1000
    const keyframes = [
      { transform: `translate(${containerWidth}px, 0px)` },
      { transform: `translate(-${element.offsetWidth}px, 0px)` }
    ]
    const animation = element.animate(keyframes, { duration })
    animation.pause()
    return animation
  }

  private isDeniedIndex(index: number, rows: number) {
    // e.g. if rows value is "12", denied index is "23", "47", "71" ...
    return index % (rows * 2) === rows * 2 - 1
  }

  private getMessages() {
    return this.timelines.reduce((carry, timelines) => {
      return carry + timelines.length
    }, 0)
  }

  private getIndex(
    messageRows: number,
    timeline: Timeline,
    settings: Settings
  ) {
    const rows = Number(settings.rows)
    let index = this.timelines.findIndex((_, i, timelines) => {
      const mod = (i + messageRows) % rows
      if (mod > 0 && mod < messageRows) {
        return false
      }
      return Array(messageRows)
        .fill(1)
        .every((_, j) => {
          if (this.isDeniedIndex(i + j, rows)) {
            return false
          }

          const ts = timelines[i + j]
          if (!ts) {
            return true
          }

          const t = ts[ts.length - 1]
          if (!t) {
            return true
          }

          return (
            t.didDisappear < timeline.willDisappear &&
            t.didAppear < timeline.willAppear
          )
        })
    })
    if (index === -1) {
      index = this.timelines.length
      const mod = (index + messageRows) % rows
      if (mod > 0 && mod < messageRows) {
        index += messageRows - mod
      }
      if (this.isDeniedIndex(index + messageRows - 1, rows)) {
        index += messageRows
      }
    }
    return index
  }

  private pushTimeline(timeline: Timeline, index: number, messageRows: number) {
    Array(messageRows)
      .fill(1)
      .forEach((_, j) => {
        const i = index + j
        if (!this.timelines[i]) {
          this.timelines[i] = []
        }
        this.timelines[i].push(timeline)
      })
  }

  async observe() {
    const items = await querySelectorAsync(
      '#items.yt-live-chat-item-list-renderer'
    )
    if (!items) {
      return
    }

    this.observer = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        const nodes = Array.from(mutation.addedNodes)
        nodes.forEach((node: Node) => {
          if (node instanceof HTMLElement) {
            this.queues.push(node)
          }
        })
      })
    })

    this.observer.observe(items, { childList: true })

    this.cleanupTimer = setInterval(() => {
      this.timelines = this.timelines.map((timelines) => {
        return timelines.filter((timeline) => {
          return timeline.didDisappear > Date.now()
        })
      })
    }, 1000)

    this.processTimer = setInterval(async () => {
      if (this.processing) {
        return
      }
      this.processing = true
      const node = this.queues.shift()
      node && (await this.flow(node))
      this.processing = false
    }, 10)
  }

  disconnect() {
    clearInterval(this.processTimer)
    clearInterval(this.cleanupTimer)
    this.observer?.disconnect()
  }

  clear() {
    parent.document.querySelectorAll('.ylcf-flow-message').forEach((e) => {
      e.remove()
    })
    this.timelines = []
  }
}