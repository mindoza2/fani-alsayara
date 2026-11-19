// Navigation + speech output helpers (kept separate to avoid circular imports).
import { settings } from './store.js';
export function go(id, params) { location.hash = '#/' + id + (params ? '?' + new URLSearchParams(params) : ''); }
export function params() { const q = location.hash.split('?')[1] || ''; return Object.fromEntries(new URLSearchParams(q)); }
export function canSpeak() { return 'speechSynthesis' in window; }
export function speak(text) {
  if (!canSpeak() || !settings().speak) return false;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(String(text).replace(/[•✓✕⚠●]/g, ''));
  u.lang = 'ar-SA';
  const v = speechSynthesis.getVoices().find(v => /^ar/i.test(v.lang)); if (v) u.voice = v;
  speechSynthesis.speak(u); return true;
}
