# homebridge-laskomex-doorbell

Vystaví domofon Laskomex osazený modulem **Smart Unifon** (projekt
[Smart Domofon](https://ediycraft.blogspot.com/2020/06/smart-domofon.html)
od Dawida Radke) do HomeKitu přes MQTT.

Vytvoří samostatná příslušenství, aby se v Apple Home dala ovládat
každé zvlášť a šlo na ně vázat automatizace:

| příslušenství | HomeKit služba | k čemu |
|---|---|---|
| `… zvonek` | `Doorbell` nebo `MotionSensor` | notifikace „někdo zvoní“ |
| `… zamek` | `LockMechanism` | otevření elektrozámku |
| `… ticho` | `Switch` | ztišení vyzvánění |
| `… auto otevirani` | `Switch` | automatické otevírání v modulu |

Zámek a přepínače se vytvoří jen tehdy, když k nim je vyplněný topic
(ve výchozím stavu jsou vyplněné všechny).

## Instalace

```bash
sudo npm install -g homebridge-laskomex-doorbell
```

## Konfigurace

Topicy jsou **předvyplněné** podle manuálu Smart Unifon (SW 2.7.2), takže
stačí vyplnit broker. Nastavit jde v Homebridge UI (plugin má
`config.schema.json`), nebo ručně:

```json
{
  "platform": "LaskomexDoorbell",
  "name": "Domofon",
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

Měnit je potřeba jen tehdy, když má modul jiný název než `smart-unifon`
(prefix = název zařízení v ESPHome).

**Pozor na dvě podtržítka** v `doorbell__ring_` — tak to ESPHome odvodil
z názvu entity „Doorbell (RING)“, není to překlep.

**Otevírání je typ `button`, ne `switch`**, takže payload je `PRESS`, nikoli
`ON`.

## Ostatní topicy modulu

Plugin je nepoužívá, ale hodí se vědět, že existují (stav se čte z `…/state`,
nastavuje publikací na `…/command`):

```
smart-unifon/status                                 online / offline
smart-unifon/binary_sensor/doorbell__ring_/state    zvonění
smart-unifon/binary_sensor/additional_button/state  tlačítko na BEX
smart-unifon/button/open_door/command               PRESS
smart-unifon/switch/mute/state                      ztišení
smart-unifon/switch/auto_open_door/state            automatické otevírání
smart-unifon/switch/auto_open__ring_/state          auto otevírání dle RING
smart-unifon/switch/door___gate/state               dveře + brána zároveň
smart-unifon/switch/scheduler_active/state          časovač ztišení
smart-unifon/switch/auto_open_scheduler_active/state
smart-unifon/switch/mute_inverted/state
smart-unifon/switch/ring_inverted/state
smart-unifon/switch/debugger/state
smart-unifon/number/call_number/state               číslo bytu pro auto-open
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

Nastavení příkladem:

```bash
mosquitto_pub -t "smart-unifon/switch/mute/command" -m "ON"
mosquitto_pub -t "smart-unifon/button/open_door/command" -m "PRESS"
```

Modul má i webové rozhraní na `http://smart-unifon.local/`, kde je vidět
totéž včetně logu a OTA aktualizace.

## Poznámky k chování

**Zvonek jako pohybový senzor.** HomePod oznamuje zvonky globálně a nejde
to vypnout pro jedno příslušenství. Kdo má ještě jiný zvonek, který na
HomePodu zvonit má, a tenhle ne, nastaví `"doorbellType": "motion"`.
Notifikace se pak zapíná u příslušenství v Apple Home.

**Otevření kódem vs. zvonění.** Modul hlásí obojí stejně, liší se jen délka
signálu `RING`: otevření kódem dává u LM-8 (CD-2501) konstantně ~8,7 s,
zvonění je kratší, nebo naopak delší podle délky stisku. Signál v rozmezí
`codeRingMinSeconds`–`codeRingMaxSeconds` se proto ignoruje. Dlouhé zvonění
se ohlásí hned po překročení horní hranice, nečeká se na konec. Na jiné
sestavě si délky ověř v logu (`Otevřeno kódem (signál … s)`).

**Volání sousedům.** Modul čte číslo každého volaného bytu. S vyplněným
`callNumber` se ohlásí jen zvonění na tvoje číslo.

**Po restartu nezvoní.** Retained zprávy z brokeru se ignorují, reaguje se
jen na přechod `OFF → ON`.

**Otevření spustí celou sekvenci.** Podle manuálu `Open Door` zvedne
sluchátko, otevře dveře a zavěsí — není to jen sepnutí kontaktu.

**Otevřít jde jen krátce po zazvonění.** Digitální domofony Laskomex pustí
elektrozámek až poté, co někdo zavolá z venkovního tabla. Když otevřeš mimo
okno `ringWindowSeconds`, plugin zapíše varování do logu, ale příkaz stejně
pošle (`warnIfNoRing: false` to vypne).

**Zámek nemá zpětnou vazbu.** `open_door` je tlačítko, takže se
`LockMechanism` po `relockSeconds` sám vrátí do „zamčeno“. Není to skutečný
stav dveří, jen odraz odeslaného povelu.

**Video nebude.** `Doorbell` bez kamery dá notifikaci, ne obraz.

## Licence

MIT
