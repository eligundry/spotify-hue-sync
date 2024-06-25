import dotenv from 'dotenv'
import { runAppleScript } from 'run-applescript'
import { getAverageColor } from 'fast-average-color-node'
import * as hue from 'node-hue-api'
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

async function connectToHue() {
  const hueBridgeDiscovery = await hue.discovery.nupnpSearch()

  if (!hueBridgeDiscovery.length) {
    throw new Error('No Hue bridges found on the network')
  }

  let authenticatedApi: HueAPI

  if (!process.env.HUE_USERNAME || !process.env.HUE_CLIENT_KEY) {
    const unauthenticatedApi = await hue.api
      .createLocal(hueBridgeDiscovery[0].ipaddress)
      .connect()

    const user = await unauthenticatedApi.users.createUser(
      'spotify-hue-sync',
      'macbook-of-eli'
    )
    console.log(`
Add these environment variables to your .env file:

HUE_USERNAME=${user.username}
HUE_CLIENT_KEY=${user.clientkey}
`)

    authenticatedApi = await hue.api
      .createLocal(hueBridgeDiscovery[0].ipaddress)
      .connect(user.username, user.clientkey)
  } else {
    authenticatedApi = await hue.api
      .createLocal(hueBridgeDiscovery[0].ipaddress)
      .connect(process.env.HUE_USERNAME, process.env.HUE_CLIENT_KEY)
  }

  return authenticatedApi
}

let previousAlbumArtworkUrl: string

async function main() {
  // First, get the album artwork from the Spotify instance running locally.
  const albumArtworkUrl = await getNativeSpotifyAlbumArtworkUrl()

  if (!albumArtworkUrl) {
    return
  } else if (!previousAlbumArtworkUrl) {
    previousAlbumArtworkUrl = albumArtworkUrl
  } else if (albumArtworkUrl === previousAlbumArtworkUrl) {
    return
  }

  // Get the average color of the album artwork
  const color = await getAverageColor(albumArtworkUrl)
  const [red, green, blue] = color.value

  // Connect to the Hue bridge and set the color on the target light
  const hueApi = await connectToHue()
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

setInterval(main, 1000)
