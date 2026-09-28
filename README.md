# homebridge-laskomex-doorbell

Brings a Laskomex intercom fitted with the **Smart Unifon** module (the
[Smart Domofon](https://ediycraft.blogspot.com/2020/06/smart-domofon.html)
project by Dawid Radke) into HomeKit over MQTT.

It creates separate accessories, so each one gets its own tile in the Home
app and can be used in automations:

| accessory | HomeKit service | purpose |
|---|---|---|
| `… Doorbell` | `Doorbell` or `MotionSensor` | "someone is ringing" notification |
| `… Lock` | `LockMechanism` | releases the door strike |
| `… Do Not Disturb` | `Switch` | mutes the handset ringer |
| `… Auto Open` | `Switch` | the module's automatic door opening |

The lock and the switches are only created when their topic is set (all of
them are set by default).

## Installation

Search for `homebridge-laskomex-doorbell` in the Homebridge UI, or:

```bash
sudo npm install -g homebridge-laskomex-doorbell
```

## Configuration

Topics are **prefilled** according to the Smart Unifon manual (SW 2.7.2), so
only the broker is required. Configure it in the Homebridge UI, or by hand:

```json
{
  "platform": "LaskomexDoorbell",
  "name": "Intercom",
  "doorbellType": "doorbell",
  "callNumber": 12,
  "broker": {
    "host": "192.168.1.10",
    "port": 1883,
    "username": "…",
    "password": "…"
  },
  "topics": {
    "ring": "smart-unifon/binary_sensor/doorbell__ring_/state",
    "openDoor": "smart-unifon/button/open_door/command",
    "openDoorPayload": "PRESS",
    "dndCommand": "smart-unifon/switch/mute/command",
    "dndState": "smart-unifon/switch/mute/state",
    "availability": "smart-unifon/status",
    "decoder": "smart-unifon/sensor/decoder/state",
    "autoOpenCommand": "smart-unifon/switch/auto_open_door/command",
    "autoOpenState": "smart-unifon/switch/auto_open_door/state"
  },
  "relockSeconds": 5,
  "ringWindowSeconds": 60,
  "codeRingMinSeconds": 8,
  "codeRingMaxSeconds": 10
}
```

Topics only need changing when the module's ESPHome device name is not
`smart-unifon` (the name is the topic prefix).

**Mind the double underscore** in `doorbell__ring_` — ESPHome derived it from
the entity name "Doorbell (RING)", it is not a typo.

**Door release is a `button`, not a `switch`**, so the payload is `PRESS`,
not `ON`.

Accessory names default to `<name> Doorbell`, `<name> Lock`,
`<name> Do Not Disturb` and `<name> Auto Open`. Override any of them with:

```json
"names": {
  "doorbell": "Front Door Bell",
  "lock": "Front Door",
  "dnd": "Intercom Mute",
  "autoOpen": "Intercom Auto Open"
}
```

## Other module topics

Not used by the plugin, but useful to know (state is read from `…/state`,
set by publishing to `…/command`):

```
smart-unifon/status                                 online / offline
smart-unifon/binary_sensor/doorbell__ring_/state    ringing
smart-unifon/binary_sensor/additional_button/state  button on BEX
smart-unifon/button/open_door/command               PRESS
smart-unifon/switch/mute/state                      mute
smart-unifon/switch/auto_open_door/state            automatic opening
smart-unifon/switch/auto_open__ring_/state          auto open on RING
smart-unifon/switch/door___gate/state               door + gate together
smart-unifon/switch/scheduler_active/state          mute scheduler
smart-unifon/switch/auto_open_scheduler_active/state
smart-unifon/switch/mute_inverted/state
smart-unifon/switch/ring_inverted/state
smart-unifon/switch/debugger/state
smart-unifon/number/call_number/state               flat number for auto open
smart-unifon/number/mute_at/state
smart-unifon/number/unmute_at/state
smart-unifon/number/auto_open_from_hour/state
smart-unifon/number/auto_open_until_hour/state
smart-unifon/select/protocol/state                  basic / …
smart-unifon/select/auto_open_target/state
smart-unifon/select/days__mute_/state
smart-unifon/select/days__auto_open_/state
smart-unifon/select/logger_select/state
smart-unifon/sensor/uptime/state
smart-unifon/sensor/ip/state
smart-unifon/sensor/wifi/state
smart-unifon/sensor/time/state
smart-unifon/sensor/esphome_version/state
```

For example:

```bash
mosquitto_pub -t "smart-unifon/switch/mute/command" -m "ON"
mosquitto_pub -t "smart-unifon/button/open_door/command" -m "PRESS"
```

The module also has a web interface at `http://smart-unifon.local/` with the
same data, a log and OTA updates.

## How it behaves

**Doorbell as a motion sensor.** HomePods announce doorbells globally and it
cannot be turned off for a single accessory. If you have another doorbell
that should ring on HomePods and this one should not, set
`"doorbellType": "motion"` and enable notifications for the accessory in the
Home app.

**Code opening vs. ringing.** The module reports both the same way; only the
length of the `RING` signal differs. On an LM-8 (CD-2501) a keypad code
opening gives a constant ~8.7 s, while a ring is shorter, or longer depending
on how long the button is held. A signal between `codeRingMinSeconds` and
`codeRingMaxSeconds` is therefore ignored. A long ring is reported as soon as
it passes the upper limit, without waiting for it to end. On a different
setup, check the actual lengths in the log (`Opened with code (signal … s)`).

**Calls to neighbours.** The module decodes the number of every flat being
called. With `callNumber` set, only rings for your flat are reported.

**No ring after restart.** Retained broker messages are ignored; only an
`OFF → ON` transition counts.

**Opening runs a full sequence.** According to the manual, `Open Door` picks
up the handset, releases the door and hangs up — it is not just a relay
pulse.

**The door only opens shortly after a ring.** Digital Laskomex intercoms
release the strike only after someone has called from the outdoor panel.
Opening outside `ringWindowSeconds` logs a warning but still sends the
command (`warnIfNoRing: false` turns the warning off).

**The lock has no feedback.** `open_door` is a button, so the
`LockMechanism` returns to "locked" by itself after `relockSeconds`. It
reflects the command sent, not the real state of the door.

**No video.** `Doorbell` without a camera gives a notification, not a
picture.

## License

MIT
