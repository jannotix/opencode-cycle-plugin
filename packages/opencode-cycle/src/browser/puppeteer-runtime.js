import "puppeteer-core/internal/node-env-setup.js"
import { environment } from "puppeteer-core/internal/environment.js"
import { PuppeteerNode } from "puppeteer-core/internal/node/PuppeteerNode.js"
import { ScreenRecorder } from "puppeteer-core/internal/node/ScreenRecorder.js"

environment.value.ScreenRecorder = ScreenRecorder

export default new PuppeteerNode({ isPuppeteerCore: true })
