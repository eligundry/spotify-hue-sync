import dotenv from 'dotenv'
import { runAppleScript } from 'run-applescript'
import { getAverageColor } from 'fast-average-color-node'
import * as hue from 'node-hue-api'
import pLimit from 'p-limit'
import type { Api as HueAPI } from 'node-hue-api/dist/esm/api/Api'
import winston from 'winston'

dotenv.config()

const logger = winston.createLogger({
  level: 'debug',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.simple()
  ),
  transports: [new winston.transports.Console()],
})

async function getNativeSpotifyAlbumArtworkUrl() {
  try {
    const state = await runAppleScript(`
if application "Spotify" is running then
  tell application "Spotify"
    return current track's artwork url
  end tell
else
  return "not-running"
end if
  `)

    if (state === 'not-running') {
      return null
    }

    return state
  } catch (e) {
    logger.error(e)
    return 'not-running'
  }
}

let _authenticatedApi: HueAPI

async function connectToHue() {
  if (_authenticatedApi) return _authenticatedApi

  let bridgeIpAddress = process.env.HUE_BRIDGE_IP

  if (!bridgeIpAddress) {
    const hueBridgeDiscovery = await hue.discovery.nupnpSearch()

    if (!hueBridgeDiscovery.length) {
      throw new Error('No Hue bridges found on the network')
    }

    bridgeIpAddress = hueBridgeDiscovery[0].ipaddress

    console.log(`
Add this environment variable to your .env:

HUE_BRIDGE_IP=${bridgeIpAddress}
`)
  }

  if (!process.env.HUE_USERNAME || !process.env.HUE_CLIENT_KEY) {
    const unauthenticatedApi = await hue.api
      .createLocal(bridgeIpAddress)
      .connect()

    const user = await unauthenticatedApi.users.createUser(
      'spotify-album-art-hue-sync',
      'macbook-of-eli'
    )
    console.log(`
Add these environment variables to your .env file:

HUE_USERNAME=${user.username}
HUE_CLIENT_KEY=${user.clientkey}
`)

    _authenticatedApi = await hue.api
      .createLocal(bridgeIpAddress)
      .connect(user.username, user.clientkey)
  } else {
    _authenticatedApi = await hue.api
      .createLocal(bridgeIpAddress)
      .connect(process.env.HUE_USERNAME, process.env.HUE_CLIENT_KEY)
  }

  return _authenticatedApi
}

let previousAlbumArtworkUrl: string

async function main() {
  // First, get the album artwork from the Spotify instance running locally.
  const albumArtworkUrl = await getNativeSpotifyAlbumArtworkUrl()

  if (!albumArtworkUrl) {
    logger.debug('Spotify is not running')
    return
  } else if (!previousAlbumArtworkUrl) {
    previousAlbumArtworkUrl = albumArtworkUrl
  } else if (albumArtworkUrl === previousAlbumArtworkUrl) {
    // console.debug('No new album artwork detected')
    return
  }

  logger.debug('updating album artwork', { albumArtworkUrl })

  // Get the average color of the album artwork
  try {
    const color = await getAverageColor(albumArtworkUrl)
    var [red, green, blue] = color.value
  } catch (e) {
    logger.error(e)
    return
  }

  logger.debug('average color', { red, green, blue })

  // Connect to the Hue bridge and set the color on the target light
  try {
    var hueApi = await connectToHue()
  } catch (e: any) {
    logger.error(e)
    return
  }

  logger.debug('connected to Hue bridge')

  let monitorLightId: string | number

  try {
    const monitorLightQuery =
      await hueApi.lights.getLightByName('Office Monitor')

    if (!monitorLightQuery?.length) {
      console.warn('No light found with the name "Office Monitor"')
      return
    }

    monitorLightId = monitorLightQuery[0].id
  } catch (e) {
    logger.error(e)
    return
  }

  logger.debug('found monitor light', { monitorLightId })

  try {
    const lightState = new hue.model.lightStates.LightState()
      .on()
      .rgb(red, green, blue)

    const result = await hueApi.lights.setLightState(monitorLightId, lightState)
    logger.debug('set light state', result)
  } catch (e) {
    logger.error(e)
    return
  }
}

const limit = pLimit(1)

setInterval(() => limit(main), 1000)
