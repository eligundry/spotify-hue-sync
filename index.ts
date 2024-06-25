import dotenv from 'dotenv'
import { runAppleScript } from 'run-applescript'
import { getAverageColor } from 'fast-average-color-node'
import * as hue from 'node-hue-api'
import pLimit from 'p-limit'
import type { Api as HueAPI } from 'node-hue-api/dist/esm/api/Api'

dotenv.config()

async function getNativeSpotifyAlbumArtworkUrl() {
  const state = await runAppleScript(`
if application "Spotify" is running then
  tell application "Spotify"
    return current track's artwork url
  end tell
else
  return "not-running"
end if
  `)

  if (state === 'not-running') return null

  return state
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
    // console.debug('Spotify is not running')
    return
  } else if (!previousAlbumArtworkUrl) {
    previousAlbumArtworkUrl = albumArtworkUrl
  } else if (albumArtworkUrl === previousAlbumArtworkUrl) {
    // console.debug('No new album artwork detected')
    return
  }

  // Get the average color of the album artwork
  const color = await getAverageColor(albumArtworkUrl)
  const [red, green, blue] = color.value

  // Connect to the Hue bridge and set the color on the target light
  try {
    var hueApi = await connectToHue()
  } catch (e: any) {
    if (e instanceof hue.ApiError) {
      console.log(e.getHueErrorType())
    }

    throw e
  }
  const monitorLightQuery = await hueApi.lights.getLightByName('Office Monitor')

  if (!monitorLightQuery?.length) {
    console.warn('No light found with the name "Office Monitor"')
    return
  }

  const monitorLightId = monitorLightQuery[0].id

  const lightState = new hue.model.lightStates.LightState()
    .on()
    .rgb(red, green, blue)

  await hueApi.lights.setLightState(monitorLightId, lightState)
}

const limit = pLimit(1)

setInterval(() => limit(main), 1000)
