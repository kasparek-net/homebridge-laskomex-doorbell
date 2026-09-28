'use strict';

const test = require('node:test');
const assert = require('node:assert');
const Module = require('node:module');
const { EventEmitter } = require('node:events');

let lastClient;
class FakeClient extends EventEmitter {
  constructor() {
    super();
    this.connected = true;
    this.published = [];
    this.subscribed = [];
  }
  subscribe(topic, cb) { this.subscribed.push(topic); if (cb) cb(null); }
  publish(topic, payload, opts, cb) { this.published.push([topic, payload]); if (cb) cb(null); }
  end() {}
}

const originalLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'mqtt') {
    return { connect: () => { lastClient = new FakeClient(); return lastClient; } };
  }
  return originalLoad.call(this, request, ...rest);
};

const pluginInit = require('..');

function makeHap() {
  class Characteristic {
    constructor(name) { this.name = name; this.value = null; }
    onGet(fn) { this.getter = fn; return this; }
    onSet(fn) { this.setter = fn; return this; }
  }
  Object.assign(Characteristic, {
    LockTargetState: { SECURED: 1, UNSECURED: 0 },
    LockCurrentState: { SECURED: 1, UNSECURED: 0 },
    ProgrammableSwitchEvent: { SINGLE_PRESS: 0 },
    MotionDetected: 'MotionDetected',
    On: 'On',
    Manufacturer: 'Manufacturer',
    Model: 'Model',
    SerialNumber: 'SerialNumber',
  });

  class Service {
    constructor(type, name) { this.type = type; this.name = name; this.chars = {}; this.updates = []; }
    getCharacteristic(c) {
      const key = typeof c === 'string' ? c : JSON.stringify(c);
      this.chars[key] = this.chars[key] || new Characteristic(key);
      return this.chars[key];
    }
    setCharacteristic() { return this; }
    updateCharacteristic(c, v) { this.updates.push([c, v]); return this; }
    setPrimaryService() {}
  }
  const S = (type) => type;
  return {
    Characteristic,
    Service: Object.assign(Service, {
      Doorbell: S('Doorbell'),
      MotionSensor: S('MotionSensor'),
      LockMechanism: S('LockMechanism'),
      Switch: S('Switch'),
      AccessoryInformation: S('AccessoryInformation'),
    }),
    Categories: { SENSOR: 1, VIDEO_DOORBELL: 2, DOOR_LOCK: 3, SWITCH: 4 },
    uuid: { generate: (s) => `uuid:${s}` },
  };
}

function makeApi() {
  const hap = makeHap();
  const api = new EventEmitter();
  api.hap = hap;
  api.registered = [];
  api.platformAccessory = class {
    constructor(displayName, UUID) {
      this.displayName = displayName;
      this.UUID = UUID;
      this.context = {};
      this.services = [new hap.Service('AccessoryInformation')];
    }
    getService(type) { return this.services.find((s) => s.type === type); }
    addService(type, name) { const s = new hap.Service(type, name); this.services.push(s); return s; }
    removeService(s) { this.services = this.services.filter((x) => x !== s); }
  };
  api.registerPlatform = (plugin, platform, ctor) => { api.Platform = ctor; };
  api.registerPlatformAccessories = (p, n, list) => api.registered.push(...list);
  api.updatePlatformAccessories = () => {};
  api.unregisterPlatformAccessories = () => {};
  pluginInit(api);
  return api;
}

function makeLog() {
  const lines = [];
  const log = (m) => lines.push(['info', m]);
  for (const level of ['info', 'warn', 'error', 'debug']) log[level] = (m) => lines.push([level, m]);
  log.lines = lines;
  return log;
}

function start(config) {
  const api = makeApi();
  const log = makeLog();
  const platform = new api.Platform(log, config, api);
  api.emit('didFinishLaunching');
  if (lastClient) lastClient.emit('connect');
  return { api, log, platform, client: lastClient };
}

const baseConfig = { platform: 'LaskomexDoorbell', name: 'Vchod', broker: { host: 'broker.test' } };

test('does not start without broker host', () => {
  lastClient = null;
  const api = makeApi();
  const log = makeLog();
  new api.Platform(log, { platform: 'LaskomexDoorbell' }, api);
  api.emit('didFinishLaunching');
  assert.strictEqual(lastClient, null);
  assert.strictEqual(api.registered.length, 0);
  assert.ok(log.lines.some(([l]) => l === 'error'));
});

test('registers doorbell, lock, dnd and auto-open accessories', () => {
  const { api, client } = start(baseConfig);
  assert.deepStrictEqual(
    api.registered.map((a) => a.displayName),
    ['Vchod Doorbell', 'Vchod Lock', 'Vchod Do Not Disturb', 'Vchod Auto Open'],
  );
  assert.ok(client.subscribed.includes('smart-unifon/binary_sensor/doorbell__ring_/state'));
});

test('ignores retained ring and code-length ring, reports short ring', (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1e12 });
  const { platform } = start(baseConfig);
  const ring = platform.topics.ring;
  const presses = () => platform.bellService.updates.length;

  platform.handleMessage(ring, 'ON', true);
  platform.handleMessage(ring, 'OFF', true);
  assert.strictEqual(presses(), 0);

  platform.handleMessage(ring, 'ON', false);
  t.mock.timers.tick(8700);
  platform.handleMessage(ring, 'OFF', false);
  assert.strictEqual(presses(), 0);

  platform.handleMessage(ring, 'ON', false);
  t.mock.timers.tick(3000);
  platform.handleMessage(ring, 'OFF', false);
  assert.strictEqual(presses(), 1);
});

test('long ring is reported before it ends', (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1e12 });
  const { platform } = start(baseConfig);
  platform.handleMessage(platform.topics.ring, 'ON', false);
  t.mock.timers.tick(10600);
  assert.strictEqual(platform.bellService.updates.length, 1);
});

test('callNumber filters rings for other flats', (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1e12 });
  const { platform } = start({ ...baseConfig, callNumber: 12 });
  platform.handleMessage(platform.topics.decoder, '3', false);
  platform.handleMessage(platform.topics.ring, 'ON', false);
  t.mock.timers.tick(2000);
  platform.handleMessage(platform.topics.ring, 'OFF', false);
  assert.strictEqual(platform.bellService.updates.length, 0);
});

test('motion mode pulses MotionDetected', (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1e12 });
  const { platform } = start({ ...baseConfig, doorbellType: 'motion' });
  assert.strictEqual(platform.bellService.type, 'MotionSensor');
  platform.triggerRing('test');
  t.mock.timers.tick(5000);
  assert.deepStrictEqual(platform.bellService.updates.map(([, v]) => v), [true, false]);
});

test('opening the lock publishes PRESS and relocks', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1e12 });
  const { platform, client } = start(baseConfig);
  const { LockTargetState, LockCurrentState } = platform.api.hap.Characteristic;
  await platform.handleOpenDoor(LockTargetState.UNSECURED);
  assert.deepStrictEqual(client.published.at(-1), ['smart-unifon/button/open_door/command', 'PRESS']);
  t.mock.timers.tick(5000);
  assert.deepStrictEqual(platform.lockService.updates.at(-1)[1], LockTargetState.SECURED);
  assert.ok(platform.lockService.updates.some(([, v]) => v === LockCurrentState.UNSECURED));
});

test('dnd switch publishes and follows state topic', async () => {
  const { platform, client } = start(baseConfig);
  await platform.handleDnd(true);
  assert.deepStrictEqual(client.published.at(-1), ['smart-unifon/switch/mute/command', 'ON']);
  platform.handleMessage(platform.topics.dndState, 'OFF', false);
  assert.strictEqual(platform.dndOn, false);
});

test('names override default accessory names', () => {
  const { api } = start({ ...baseConfig, names: { doorbell: 'Vchod zvonek', lock: 'Vchod zamek' } });
  assert.deepStrictEqual(api.registered.map((a) => a.displayName).slice(0, 2), ['Vchod zvonek', 'Vchod zamek']);
});
