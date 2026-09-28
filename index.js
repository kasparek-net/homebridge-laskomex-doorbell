'use strict';

const mqtt = require('mqtt');

const PLUGIN_NAME = 'homebridge-laskomex-doorbell';
const PLATFORM_NAME = 'LaskomexDoorbell';

let Service;
let Characteristic;
let Categories;

module.exports = (api) => {
  Service = api.hap.Service;
  Characteristic = api.hap.Characteristic;
  Categories = api.hap.Categories;
  api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, LaskomexDoorbellPlatform);
};

class LaskomexDoorbellPlatform {
  constructor(log, config, api) {
    this.log = log;
    this.config = config || {};
    this.api = api;
    this.accessories = [];
    this.client = null;
    this.lastRingAt = 0;

    this.name = this.config.name || 'Domofon';
    this.relockSeconds = numberOr(this.config.relockSeconds, 5);
    this.ringWindowSeconds = numberOr(this.config.ringWindowSeconds, 60);
    this.warnIfNoRing = this.config.warnIfNoRing !== false;

    this.topics = Object.assign({
      ring: 'smart-unifon/binary_sensor/doorbell__ring_/state',
      openDoor: 'smart-unifon/button/open_door/command',
      openDoorPayload: 'PRESS',
      dndCommand: 'smart-unifon/switch/mute/command',
      dndState: 'smart-unifon/switch/mute/state',
      dndOnPayload: 'ON',
      dndOffPayload: 'OFF',
      availability: 'smart-unifon/status',
      availablePayload: 'online',
      decoder: 'smart-unifon/sensor/decoder/state',
      decodingSuccessful: 'smart-unifon/binary_sensor/decoding_successful/state',
      autoOpenCommand: 'smart-unifon/switch/auto_open_door/command',
      autoOpenState: 'smart-unifon/switch/auto_open_door/state',
    }, this.config.topics || {});

    this.callNumber = this.config.callNumber != null ? String(this.config.callNumber) : null;
    this.lastDecoded = null;
    this.ringWasOn = false;
    this.ringStartedAt = 0;
    this.ringTimer = null;
    this.codeRingMin = numberOr(this.config.codeRingMinSeconds, 8);
    this.codeRingMax = numberOr(this.config.codeRingMaxSeconds, 10);

    this.ringPayload = this.config.ringPayload || 'ON';

    if (!this.config.broker || !this.config.broker.host) {
      this.log.error('Chybí broker.host v konfiguraci — plugin se nespustí.');
      return;
    }
    if (!this.topics.ring && !this.topics.decodingSuccessful) {
      this.log.warn('Není nastavený žádný zdroj zvonění (ring ani decodingSuccessful).');
    }
    if (this.topics.decodingSuccessful && !this.callNumber) {
      this.log.warn('callNumber není nastavené — zvonek se ozve i při volání sousedům.');
    }

    this.api.on('didFinishLaunching', () => {
      this.setupAccessories();
      this.connect();
    });

    this.api.on('shutdown', () => {
      if (this.client) this.client.end(true);
    });
  }

  configureAccessory(accessory) {
    this.accessories.push(accessory);
  }

  setupAccessories() {
    const names = this.config.names || {};
    const nameFor = (key, fallback) => names[key] || `${this.name} ${fallback}`;

    const bellName = nameFor('doorbell', 'zvonek');
    // motion = HomePod zvonek neoznamuje, doorbell = oznamuje (nelze vypnout pro jedno prislusenstvi)
    this.bellIsMotion = String(this.config.doorbellType || 'doorbell').toLowerCase() === 'motion';

    this.doorbell = this.ensureAccessory(
      'doorbell', bellName, this.bellIsMotion ? Categories.SENSOR : Categories.VIDEO_DOORBELL,
    );

    const chtena = this.bellIsMotion ? Service.MotionSensor : Service.Doorbell;
    const nechtena = this.bellIsMotion ? Service.Doorbell : Service.MotionSensor;
    const zbyla = this.doorbell.getService(nechtena);
    if (zbyla && this.doorbell.removeService) {
      this.doorbell.removeService(zbyla);
      this.log.info(`Typ zvonku změněn na ${this.bellIsMotion ? 'MotionSensor' : 'Doorbell'}.`);
    }

    const bell = this.doorbell.getService(chtena) || this.doorbell.addService(chtena, bellName);
    bell.setPrimaryService(true);
    this.bellService = bell;

    if (this.bellIsMotion) {
      this.motionSeconds = numberOr(this.config.motionSeconds, 5);
      bell.getCharacteristic(Characteristic.MotionDetected).onGet(() => false);
    }

    if (this.topics.openDoor) {
      const lockName = nameFor('lock', 'zamek');
      this.lock = this.ensureAccessory('lock', lockName, Categories.DOOR_LOCK);
      const lockService = this.lock.getService(Service.LockMechanism)
        || this.lock.addService(Service.LockMechanism, lockName);

      lockService.getCharacteristic(Characteristic.LockTargetState)
        .onGet(() => Characteristic.LockTargetState.SECURED)
        .onSet(this.handleOpenDoor.bind(this));

      lockService.getCharacteristic(Characteristic.LockCurrentState)
        .onGet(() => Characteristic.LockCurrentState.SECURED);

      this.lockService = lockService;
    }

    if (this.topics.dndCommand) {
      const dndName = nameFor('dnd', 'ticho');
      this.dnd = this.ensureAccessory('dnd', dndName, Categories.SWITCH);
      const dndService = this.dnd.getService(Service.Switch)
        || this.dnd.addService(Service.Switch, dndName);

      this.dndOn = false;
      dndService.getCharacteristic(Characteristic.On)
        .onGet(() => this.dndOn)
        .onSet(this.handleDnd.bind(this));

      this.dndService = dndService;
    }

    if (this.topics.autoOpenCommand) {
      const autoName = nameFor('autoOpen', 'auto otevirani');
      this.autoOpen = this.ensureAccessory('autoopen', autoName, Categories.SWITCH);
      const autoService = this.autoOpen.getService(Service.Switch)
        || this.autoOpen.addService(Service.Switch, autoName);

      this.autoOpenOn = false;
      autoService.getCharacteristic(Characteristic.On)
        .onGet(() => this.autoOpenOn)
        .onSet(async (v) => {
          this.autoOpenOn = Boolean(v);
          if (this.autoOpenOn) {
            this.log.warn('Automatické otevírání ZAPNUTO — komukoli, kdo zazvoní, se otevře.');
          } else {
            this.log.info('Automatické otevírání vypnuto.');
          }
          this.publish(this.topics.autoOpenCommand, this.autoOpenOn ? 'ON' : 'OFF');
        });

      this.autoOpenService = autoService;
    }

    this.pruneStaleAccessories();
  }

  ensureAccessory(key, displayName, category) {
    const uuid = this.api.hap.uuid.generate(`${PLUGIN_NAME}:${key}`);
    let accessory = this.accessories.find((a) => a.UUID === uuid);

    if (accessory) {
      accessory.displayName = displayName;
      this.api.updatePlatformAccessories([accessory]);
    } else {
      accessory = new this.api.platformAccessory(displayName, uuid, category);
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.accessories.push(accessory);
      this.log.info(`Přidáno příslušenství: ${displayName}`);
    }

    accessory.category = category;
    accessory.displayName = displayName;
    accessory.context.key = key;

    const info = accessory.getService(Service.AccessoryInformation);
    if (info) {
      info.setCharacteristic(Characteristic.Manufacturer, 'Laskomex + ediycraft')
        .setCharacteristic(Characteristic.Model, this.config.model || 'LM-8 smart module')
        .setCharacteristic(Characteristic.SerialNumber, `${this.name}-${key}`);
    }
    return accessory;
  }

  pruneStaleAccessories() {
    const live = [this.doorbell, this.lock, this.dnd, this.autoOpen].filter(Boolean).map((a) => a.UUID);
    const stale = this.accessories.filter((a) => !live.includes(a.UUID));
    if (stale.length) {
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale);
      this.accessories = this.accessories.filter((a) => live.includes(a.UUID));
      stale.forEach((a) => this.log.info(`Odebráno nepoužívané příslušenství: ${a.displayName}`));
    }
  }

  connect() {
    const b = this.config.broker;
    const url = `${b.protocol || 'mqtt'}://${b.host}:${b.port || 1883}`;

    this.client = mqtt.connect(url, {
      username: b.username || undefined,
      password: b.password || undefined,
      clientId: b.clientId || `homebridge-laskomex-${Math.random().toString(16).slice(2, 10)}`,
      reconnectPeriod: 5000,
      connectTimeout: 15000,
      clean: true,
    });

    this.client.on('connect', () => {
      this.log.info(`Připojeno k MQTT ${url}`);
      [this.topics.ring, this.topics.dndState, this.topics.availability,
        this.topics.decoder, this.topics.decodingSuccessful, this.topics.autoOpenState]
        .filter(Boolean)
        .forEach((t) => this.client.subscribe(t, (err) => {
          if (err) this.log.error(`Nelze odebírat ${t}: ${err.message}`);
        }));
    });

    this.client.on('message', (topic, payload, packet) => {
      this.handleMessage(topic, payload.toString().trim(), Boolean(packet && packet.retain));
    });
    this.client.on('error', (err) => this.log.error(`Chyba MQTT: ${err.message}`));
    this.client.on('reconnect', () => this.log.debug('MQTT reconnect…'));
    this.client.on('close', () => this.log.debug('MQTT spojení zavřeno'));
  }

  handleMessage(topic, value, retained) {
    if (topic === this.topics.decoder) {
      this.lastDecoded = String(parseInt(value, 10));
      return;
    }

    if (topic === this.topics.ring) {
      const zvoni = value === this.ringPayload;
      const predtim = this.ringWasOn;
      this.ringWasOn = zvoni;
      if (retained) return;

      if (zvoni && !predtim) {
        this.ringStartedAt = Date.now();
        // dlouhe zvoneni: neceka se na konec, ohlasi se po prekroceni horni hranice
        clearTimeout(this.ringTimer);
        this.ringTimer = setTimeout(() => {
          if (this.ringWasOn) this.triggerRing('dlouhé zvonění');
        }, (this.codeRingMax + 0.5) * 1000);
        return;
      }

      if (!zvoni && predtim && this.ringStartedAt) {
        clearTimeout(this.ringTimer);
        const delka = (Date.now() - this.ringStartedAt) / 1000;
        this.ringStartedAt = 0;
        if (delka >= this.codeRingMin && delka <= this.codeRingMax) {
          this.log.info(`Otevřeno kódem (signál ${delka.toFixed(1)} s) — nezvoním.`);
        } else if (delka < this.codeRingMin) {
          this.triggerRing(`krátké zvonění, ${delka.toFixed(1)} s`);
        }
      }
      return;
    }

    if (topic === this.topics.decodingSuccessful) {
      return;
    }

    if (this.dndService && topic === this.topics.dndState) {
      this.dndOn = value === this.topics.dndOnPayload;
      this.dndService.updateCharacteristic(Characteristic.On, this.dndOn);
      return;
    }

    if (this.autoOpenService && topic === this.topics.autoOpenState) {
      this.autoOpenOn = value === 'ON';
      this.autoOpenService.updateCharacteristic(Characteristic.On, this.autoOpenOn);
      return;
    }

    if (topic === this.topics.availability) {
      const online = value === this.topics.availablePayload;
      this.log.info(`Modul je ${online ? 'online' : 'offline'}`);
    }
  }

  triggerRing(zdroj) {
    if (this.callNumber && this.lastDecoded && this.lastDecoded !== this.callNumber) {
      this.log.debug(`Volali na ${this.lastDecoded}, ne na ${this.callNumber} — ignoruji.`);
      return;
    }
    const now = Date.now();
    if (now - this.lastRingAt < 5000) return;
    this.lastRingAt = now;
    this.log.info(`Zvonění! (${zdroj})`);

    if (this.bellIsMotion) {
      this.bellService.updateCharacteristic(Characteristic.MotionDetected, true);
      clearTimeout(this.motionTimer);
      this.motionTimer = setTimeout(() => {
        this.bellService.updateCharacteristic(Characteristic.MotionDetected, false);
      }, this.motionSeconds * 1000);
      return;
    }

    this.bellService.updateCharacteristic(
      Characteristic.ProgrammableSwitchEvent,
      Characteristic.ProgrammableSwitchEvent.SINGLE_PRESS,
    );
  }

  async handleOpenDoor(value) {
    if (value !== Characteristic.LockTargetState.UNSECURED) return;

    const sinceRing = (Date.now() - this.lastRingAt) / 1000;
    if (this.warnIfNoRing && sinceRing > this.ringWindowSeconds) {
      this.log.warn(
        'Otevírám, ale poslední zvonění bylo před ' +
        (this.lastRingAt ? `${Math.round(sinceRing)} s` : 'nikdy') +
        '. Digitální domofon otevře jen po vyzvánění z tabla — nejspíš se nic nestane.',
      );
    }

    this.publish(this.topics.openDoor, this.topics.openDoorPayload);
    this.lockService.updateCharacteristic(
      Characteristic.LockCurrentState, Characteristic.LockCurrentState.UNSECURED,
    );

    setTimeout(() => {
      this.lockService.updateCharacteristic(
        Characteristic.LockCurrentState, Characteristic.LockCurrentState.SECURED,
      );
      this.lockService.updateCharacteristic(
        Characteristic.LockTargetState, Characteristic.LockTargetState.SECURED,
      );
    }, this.relockSeconds * 1000);
  }

  async handleDnd(value) {
    this.dndOn = Boolean(value);
    this.publish(
      this.topics.dndCommand,
      this.dndOn ? this.topics.dndOnPayload : this.topics.dndOffPayload,
    );
  }

  publish(topic, payload) {
    if (!topic) return;
    if (!this.client || !this.client.connected) {
      this.log.error(`MQTT není připojené, zahazuji ${topic}`);
      return;
    }
    this.client.publish(topic, payload, { qos: 1 }, (err) => {
      if (err) this.log.error(`Publish na ${topic} selhal: ${err.message}`);
      else this.log.debug(`→ ${topic}: ${payload}`);
    });
  }
}

function numberOr(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
