/* Live check of the exact path the new fallback uses:
 * dist LmuLocalCarReader.read(focusSlotId) on the spectated car. Read-only. */
'use strict';
const http = require('node:http');
const { LmuLocalCarReader } = require('../dist/telemetry/lmuLocalCar.js');

function getJson(path) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: 6397, path, timeout: 2500 }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
  });
}

async function main() {
  const cars = await getJson('/rest/watch/standings');
  const focus = cars.find((c) => c.hasFocus || c.focus);
  if (!focus) { console.log('no focused car'); process.exit(1); }
  console.log('focus: #' + focus.carNumber + ' ' + focus.driverName + ' slot ' + focus.slotID +
    '  restSpeed=' + (focus.carVelocity.velocity * 3.6).toFixed(0) + ' km/h');

  const reader = new LmuLocalCarReader();
  reader.start();
  let ok = 0, nulls = 0;
  const gears = new Set();
  for (let i = 0; i < 40; i++) {
    const car = reader.read(focus.slotID);
    if (!car) { nulls++; }
    else {
      ok++;
      gears.add(car.gear);
      if (i % 8 === 0) {
        console.log('  gear=' + car.gear + ' rpm=' + car.rpm.toFixed(0) + '/' + car.maxRpm.toFixed(0) +
          ' spd=' + car.speedKph + 'km/h thr=' + car.throttle.toFixed(2) + ' brk=' + car.brake.toFixed(2) +
          ' steer=' + car.steer.toFixed(2) + ' tc=' + car.tc.toFixed(2) + ' abs=' + car.abs.toFixed(2) +
          ' tyreHud=' + JSON.stringify(car.tyreHudTempsC) + ' fuel=' + car.fuelLiters.toFixed(1) +
          ' num=' + car.carNumber);
      }
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  reader.stop();
  console.log('reads ok=' + ok + ' null=' + nulls + '  gears seen: ' + [...gears].sort().join(','));
}
main().catch((e) => { console.error(e); process.exit(1); });
