const { Server } = require('ws')
const { BitView } = require('bit-buffer')
const log = require('./logger')

const cats = require('./dbc/tm3/categories.json') /// <>>>> TEMP wrap this in DBC object - find way to share with client
const defs = require('./dbc/tm3/definitions.json') /// <>>>> TEMP wrap this in DBC object - find way to share with client
const DBC = require('./dbc')

const dbc = new DBC(cats, defs)

// Interval at which to ping connections
const PING_INTERVAL = 1000

// Maximum allowable latency before the server terminates connections
const UNRESPONSIVE_LATENCY = 4000

// Message that instructs the M2 to disable sending of all messages, this is the
// only M2 binary message known to the server; it's here to provide a level of
// security for stopping the sending of data that's no longer needed in case all
// clients are disconnected
const DISABLE_ALL_MSGS = Uint8Array.of(1, 1, 0)

// The M2 device web socket
let m2 = null

// The timestamp of all recently received message from the M2
let recentMsgAt = []
let recentRate = 0

// Create a standalone socket server so that we can route data from both http and
// https servers to it
const wss = new Server({ noServer: true })

// Connection handler for incoming socket requests
wss.on('connection', (ws) => {

  // route incoming connections to either the M2 handle or the client handler
  if (ws.url.pathname === '/m2device') {
    handleM2(ws)
  } else {
    handleClient(ws)
  }

  // reset ping time to zero (at), effectively resetting the circuit breaker for this
  // connection and update the latency information
  ws.at = 0
  ws.on('pong', () => {
    ws.latency = Date.now() - ws.at
    ws.at = 0
    log.debug(`Latency of ${ws.name}-${ws.id} is ${ws.latency} ms`)
  })
})

// Ping pong mechanism to prevent idle disconnects, detect unresponsive web sockets,
// and calculate latency
setInterval(() => {
  const now = Date.now()
  const status = currentStatus()
  wss.clients.forEach((ws) => {
    if (ws.at !== 0) {
      ws.latency = now - ws.at
      if (ws.latency >= UNRESPONSIVE_LATENCY) {
        log.warn(`Terminating ${ws.name}-${ws.id} because latency is ${ws.latency}`)
        return ws.terminate()
      }
    }
    else {
      ws.at = now
      ws.ping()
    }
    send(ws, 'status', status)
  })
}, PING_INTERVAL)

// M2 message rate mechanism
setInterval(() => {
  const now = Date.now()
  recentMsgAt = recentMsgAt.filter(t => now - t <= 1000)
  recentRate = recentMsgAt.length
}, 1000)

// M2 handling that broadcasts all binary messages send by the device
function handleM2(ws) {
  log.info(`New m2-${ws.id} connection`)
  ws.name = 'm2'

  if (m2) {
    log.warn(`Terminating m2-${m2.id} due to new connection`)
    const prevM2 = m2
    m2 = ws
    prevM2.terminate()
  }
  else {
    m2 = ws
    broadcast('status', currentStatus())
  }

  const at = []
  function handleMessage(msg) {
    recentMsgAt.push(Date.now())
    //broadcast('message', Array.from(msg))
    processMessage(msg)
  }

  ws.on('message', handleMessage)

  ws.on('close', () => {
    log.info(`Detected closing of m2-${ws.id}`)
    if (ws === m2 ) {
      m2 = null
      broadcast('status', currentStatus())
    }
  })
}

// Client send convenience function that packages the data into a json event
function send(ws, event, data) {
  ws.send(JSON.stringify({ event, data }))
}

// Get the current state of the M2
function currentStatus() {
  let online = false
  let latency = 0
  let rate = recentRate
  if (m2 !== null) {
    online = true
    latency = m2.latency || 0
  }
  return { online, latency, rate }
}

var signalEnabledMessageRefs = {} // a map of how many signals require a given message

function addSignalMessageRef(signal) {
  let refs = signalEnabledMessageRefs[signal.message.mnemonic] || 0
  if (refs === 0) {
    enableMessage(signal.message.id)
  }
  signalEnabledMessageRefs[signal.message.mnemonic] = refs + 1
}

function releaseSignalMessageRef(signal) {
  let refs = signalEnabledMessageRefs[signal.message.mnemonic] || 0
  if (refs > 0) {
    if (refs === 1) {
      disableMessage(signal.message.id)
    }
    signalEnabledMessageRefs[signal.message.mnemonic] = refs - 1
  }
}

const CAN_MSG_FLAG_RESET = 0x00
const CAN_MSG_FLAG_TRANSMIT = 0x01
const CMDID_SET_ALL_MSG_FLAGS = 0x01
const CMDID_SET_MSG_FLAGS = 0x02
const CMDID_GET_MSG_LAST_VALUE = 0x03

function getLastMessageValue(id) {
  const size = 2
  if (m2) {
    m2.send(Uint8Array.from([CMDID_GET_MSG_LAST_VALUE, size, id & 0xff, id >> 8]))
  }
}

function setAllMessageFlags(flags) {
  const size = 1
  if (m2) {
    m2.send(Uint8Array.from([CMDID_SET_ALL_MSG_FLAGS, size, flags & 0xff]))
  }
}

function setMessageFlags(id, flags) {
  const size = 3
  if (m2) {
    m2.send(Uint8Array.from([CMDID_SET_MSG_FLAGS, size, id & 0xff, id >> 8, flags & 0xff]))
  }
}

function enableAllMessages() {
  setAllMessageFlags(CAN_MSG_FLAG_TRANSMIT)
}

function disableAllMessages() {
  setAllMessageFlags(CAN_MSG_FLAG_RESET)
}

function enableMessage(id) {
  getLastMessageValue(id)
  setMessageFlags(id, CAN_MSG_FLAG_TRANSMIT)
}

function disableMessage(id) {
  setMessageFlags(id, CAN_MSG_FLAG_RESET)
}

function decodeMessage(msg) {
  if (msg.length >= 7) {
    const ts = msg.readUInt32LE()
    const id = msg.readUInt16LE(4)
    const len = msg.readUInt8(6)
    const data = msg.slice(7, 7 + len)

    // const ts = msg[0] | (msg[1] << 8) | (msg[2] << 16) | (msg[3] << 24)
    // const id = msg[4] | (msg[5] << 8)
    // const len = msg[6]
    // const value = msg.slice(7, 7 + len)
    return { ts, id, data }
  }
  return {}
}

function decodeSignal(buf, def) {
  try {
    const val = buf.getBits(def.start, def.length, def.signed)
    return def.offset + def.scale * val
  } catch {
    return NaN
  }
}

function processMessage(msg) {
  const { id, ts, data } = decodeMessage(msg)
  if (!id) {
    return log.warn(`Invalid message format: ${data}`)
  }
  const def = dbc.getMessageFromId(id)
  if (!def) {
    return log.warn(`No definition for message ${id}`)
  }
  const ingress = {}
  const buf = new BitView(data)
  if (def.signals) {
    def.signals.forEach(s => {
      ingress[s.mnemonic] = decodeSignal(buf, s)
    })
  }
  if (def.multiplexor) {
    const multiplexId = ingress[def.multiplexor.mnemonic] = decodeSignal(buf, def.multiplexor)
    const multiplexed = def.multiplexed[multiplexId]
    if (multiplexed) {
      multiplexed.forEach(s => {
        ingress[s.mnemonic] = decodeSignal(buf, s)
      })
    } else {
      log.warn(`Message ${def.mnemonic} doesn't have a multiplexed signal for ${multiplexId}`)
    }
  }
  /// ><>>> TODO: broadcast only to subscribed clients
  Object.keys(ingress).forEach(mnemonic => {
    const value = ingress[mnemonic]
    //if (listeners[mnemonic]) {
      broadcast('signal', { mnemonic, value })
      //listeners[mnemonic].forEach(l => l(value))
    //}
  })
}

// Client handling that relays commands to the M2, and implements the message level
// ping pong mechanism
function handleClient(ws) {
  log.info(`New client-${ws.id} connection`)
  ws.name = 'client'
  send(ws, 'hello', {
    session: ws.id
  })
  ws.on('message', (msg) => {
    try {
      var { event, data } = JSON.parse(msg)
    }
    catch {
      log.warn(`Cannot parse message from client-${ws.id}: ${msg}`)
    }
    switch (event) {
      case 'ping': {
        send(ws, 'pong')
        break
      }

      case 'subscribe': {
        log.info(`Subscribe from client-${ws.id} for ${data}`)
        const signal = dbc.getSignal(data)
        addSignalMessageRef(signal)
        break
      }

      case 'unsubscribe': {
        log.info(`Unsubscribe from client-${ws.id} for ${data}`)
        const signal = dbc.getSignal(data)
        releaseSignalMessageRef(signal)
        break
      }

      default: {
        log.warn(`Unknown event from client-${ws.id}: ${event}`)
      }
    }
  })

  ws.on('close', () => {
    log.info(`Detected closing of ${ws.name}-${ws.id}`)
    if (m2 !== null && wss.clients.size == 1) {
      log.info('Disabling all M2 messages')
      m2.send(DISABLE_ALL_MSGS)
    }
  })
}

// Broadcast an M2 message to all connected clients
function broadcast(event, data) {
  wss.clients.forEach(ws => {
    if (ws !== m2 && ws.readyState === 1) {
      send(ws, event, data)
    }
  })
}

// Authorization verification
function authorize(url) {
  return url.searchParams.get('pin') === process.env.AUTHORIZATION
}

// Handle upgrade requests from the server(s) and verify authorization
let nextId = 1
function handleUpgrade(req, socket, head) {
  const url = new URL(req.url, `ws://${req.headers.host}`)
  const id = nextId++
  log.info(`Upgrading connection ${id} with url ${req.url} from ${req.socket.remoteAddress}`)

  const authorized = authorize(url)
  if (!authorized) {
    log.warn(`Authorization failed for connection ${id}`)
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
    socket.destroy()
    return
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.id = id
    ws.url = url
    wss.emit('connection', ws)
  })
}

module.exports = handleUpgrade