import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchesQuery } from '../src/sources/match.js';

const yes: [string, string][] = [
  ['Raspberry Pi 5 Model 8GB RAM', 'raspberry pi 5'],
  ['Official 27W USB-C Power Supply for Raspberry Pi 5', 'raspberry pi 5'],
  ['Akasa Pi-5 Pro - Aluminum Raspberry Pi 5 Enclosure', 'raspberry pi 5'],
  ['holybro pixhawk 6x autopilot flight controller', 'pixhawk 6x'],
  ['Waveshare PoE HAT (G) For Raspberry Pi 5', 'raspberry pi 5 hat'],
  ['SpeedyBee F405 Flight Controllers', 'flight controller'],
];
const no: [string, string][] = [
  ['ir cut camera 5 mp ov5647 for raspberry pi', 'raspberry pi 5'], // real bug from Robu slugs
  ['acrylic case suitable for raspberry pi4 3 5 inch lcd', 'raspberry pi 5'],
  ['Raspberry Pi 5MP Telephoto Lens', 'raspberry pi 5'],
  ['Pixhawk Pro 6C Kit', 'pixhawk 6x'],
  ['Pixhawk Flight Controller Passive Buzzer', 'pixhawk 6x'],
];

for (const [title, q] of yes) test(`"${q}" matches "${title}"`, () => assert.ok(matchesQuery(title, q)));
for (const [title, q] of no) test(`"${q}" does NOT match "${title}"`, () => assert.ok(!matchesQuery(title, q)));
