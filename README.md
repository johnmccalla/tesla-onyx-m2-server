# Onyx M2 Server

This project is a Node socket server that works in conjunction with [onyx-m2-firmware](https://github.com/johnmccalla/tesla-onyx-m2-firmware), which allows a Macchina M2 to use this server to relay CANBUS messages to the Model 3's main screen.

*NOTE: This documentation is a work in progress!!! Please open issues to ask questions as needed.*

# Installation

This is currently a pretty straight forward Node/Express server.

Start by setting up your environment in a .env file. It should have at least an `AUTHORIZATION` entry, which corresponds
to the `pin` query string you need to provide to be able to access the relay.

If you want to deploy a secure version of the server, you should additionally have `SSL_KEY` and `SSL_CERT` that point
to your SSL files. You almost certainly want this to use with any web app running on the car's main screen (as most
hosting services require it now, for example, AWS Amplify).

You may also specify a `M2_HOSTNAME` value, which will be used by the tools to access your deployment.

```
  # .env
  M2_HOSTNAME=your_server_hostname_here
  AUTHORIZATION=your_authorization_code_here
  NODE_ENV=production
```

You should then be able to run.
```
  npm install
  npm start
```

# M2 Message Protocol

The M2 must be configured to open a web socket connection using the `/m2device` endpoint,
passing a `pin` query string corresponding to the agreed upon `AUTHORIZATION` value.

Clients may connect to any other endpoint, using the same `pin`.

## Ping Pong Messages

Clients may implement a user level ping/pong mechanism. This is implemented to allow
web browser based applications detect stale connection. Anytime a client sends the
text message `ping`, the server will respond with a text message `pong`.

The server also implements protocol level ping pong for all connections, including the
M2.

## M2 Notification Messages

The server will send regular notifications to clients about the state of the M2. These
notifications will be sent as text messages starting with the `m2:` prefix. The full
schema is `m2:{conn}:{lat}`

  - `conn` is the connection state, `1` means the M2 is online, and `0` means it's
    offline
  - `lat` is the current latency in milliseconds of `pong` messages initiated by
    the server's `ping` requests to the M2, and therefore represents a full round
    trip between the M2 and the server

The latency can be combined with a client's own latency information (gleaned from
the message level ping pong messages) to get an idea of the delay between a CAN
message being read off the car's bus and its display on the in car screen. The formula
would be `(client_latency / 2) + (m2_latency / 2)`.

## Data Messages

Any message that is binary is assumed to be a CAN message from the M2, or a control
message from a client. The server does not unpack any of these binary messages, but
rather acts like a relay.

See [onyx-m2-firmware](https://github.com/johnmccalla/tesla-onyx-m2-firmware) for
up to date information on the format of the CAN messages and the commands.

# Deployment

*TODO*: a simple shoe string deployment example

To run node apps on ports below 1024, run this once (and every time you upgrade your
node installation)
```
sudo setcap 'cap_net_bind_service=+ep' /usr/bin/node
```

# Apps

There are no longer any apps provided as part of the server. The server is now purely a data relay,
augmented with some json data access services.

# Tools

There are a number of tools included that will help with development.

- `bin/onyx-m2-monitor` monitors the canbus messages and saves them to a log file.
- `bin/m2-serial-replay` replays a log file to the serial port. This is useful for debugging the superb communication from the workbench.
- `bin/m2-ws-replay` replays a log file to the websocket. This is useful to debug application without having to be in the car and/or driving.
- `bin/parse-dbc` parses a dbc file and outputs a json file that may be consumed by applications.

# Higher Level Client Protocol

What if did all the signal wrangling on the server, and presented clients with a
nice high level interface to messages?

Possible flow:

```js
  // Server sends hello, you are session X
  {
    event: 'hello',
    data: {
      session: id,
    }
  }

  // Client then responds by setting up its subscriptions
  {
    event: 'subscribe',
    data: ['DI_elecPower']
  }

  // Client can also later unsubscribe to a signal
  {
    event: 'unsubscribe',
    data: ['DI_elecPower']
  }

  // When a subscribed signal is received from the M2, the server sends
  {
    event: 'signal',
    data: [
      ['DI_elecPower', 200]
      ...
    ]
  }

  // Clients can also request the last value of a number of signals (the server will emit
  // the same signal event as a response to this, but not subscribe)
  {
    event: 'get',
    data: ['DI_isSunUp']
  }

  // Clients can ask to be sniffers, which enables all messages on the M2 and forwards
  // them to the client
  {
    event: 'sniffer',
    data: true
  }

  // Client can also ask to be passive monitors, and receive all messages sent by
  // the M2
  {
    event: 'monitor',
    data: true
  }

  // Clients can also request the last value of a given message id on a given bus (the
  // server will emit the same message and signals events as a response to this that
  // it does when data is received from the M2)
  {
    event: 'get-message',
    data: {
      bus: 0,
      id: 789
    }
  }

  // Clients can also request the last value of a every message (the
  // server will emit the same message and signals events as a response to this that
  // it does when data is received from the M2)
  {
    event: 'get-all-messages'
  }

  // Server sends all messages to monitors and sniffers
  {
    event: 'message'
    data: [id, ts, [0x12, 0x12, 0x12, ...]]
  }

  // Ping pong is implemented by having the client send
  {
    event: 'ping'
  }

  // and the responds with
  {
    event: 'pong'
  }

  // Server will also send client periodic updates on the M2's status (including rate of
  // messages emitted)
  {
    event: 'status',
    data: [online, latency, rate]
  }
```