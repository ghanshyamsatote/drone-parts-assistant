import { addWatch, listWatches } from '../db/repo.js';

// Day-1 watchlist required by the brief. These are QUERY watches: each run
// searches every source for these terms, so we pick up all matching listings
// (and new ones that appear later) without hardcoding product URLs.
const SEED: { value: string; label: string }[] = [
  { value: 'Raspberry Pi 5', label: 'Raspberry Pi 5' },
  { value: 'Raspberry Pi 5 HAT', label: 'Pi 5-compatible HATs' },
  { value: 'Pixhawk 6X', label: 'Holybro Pixhawk 6X' },
  { value: 'flight controller', label: 'Flight controllers (category)' },
  { value: 'Jetson Orin', label: 'Companion computers: NVIDIA Jetson Orin' }, // stores name the board, not the role
];

for (const s of SEED) addWatch('query', s.value, s.label, null);

console.table(listWatches().map(({ id, kind, value, label }) => ({ id, kind, value, label })));
