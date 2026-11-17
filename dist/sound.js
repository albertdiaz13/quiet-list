// Sound cues, synthesized in the browser. No audio files, nothing downloaded.
//
// Rules this module keeps:
//  - No audio engine exists until the person has touched or typed (browsers require that anyway),
//    so nothing can play on page load.
//  - A cue plays only when app code asks for it, and app code asks only from the person's own
//    actions, never for changes arriving from another device.
//  - Off means off: no engine is created or kept running.
//  - iPhone's silent switch and the device volume still apply; this cannot override them.

const NOTE = name => 440 * 2 ** (name / 12);          // semitones from A4
const PENTATONIC = [3, 5, 7, 10, 12, 15, 17, 19, 22, 24];   // C major pentatonic, from C5
const CLIMB = [0, 2, 4, 7, 9, 12, 14, 16];                  // how far each step of a completion run is raised

export function createSound({ enabled = true } = {}) {
  let on = enabled;
  let context = null, out = null, unlocked = false;

  const report = () => { document.documentElement.dataset.audio = !on ? 'off' : context ? context.state : 'idle'; };

  function engine() {
    if (context || !on || !unlocked) return context;
    const Engine = window.AudioContext || window.webkitAudioContext;
    if (!Engine) return null;
    try {
      context = new Engine({ latencyHint: 'interactive' });
      const limiter = context.createDynamicsCompressor();
      limiter.threshold.value = -18; limiter.ratio.value = 6;
      out = context.createGain();
      out.gain.value = 0.5;
      out.connect(limiter).connect(context.destination);
      context.addEventListener('statechange', report);
    } catch { context = null; }
    return context;
  }

  // One soft voice: an oscillator through its own envelope.
  function tone({ at = 0, from, to = from, length = 0.12, level = 0.2, shape = 'sine', attack = 0.006 }) {
    const start = context.currentTime + at;
    const osc = context.createOscillator(), gain = context.createGain();
    osc.type = shape;
    osc.frequency.setValueAtTime(from, start);
    if (to !== from) osc.frequency.exponentialRampToValueAtTime(to, start + length);
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(level, start + attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + length);
    osc.connect(gain).connect(out);
    osc.start(start); osc.stop(start + length + 0.02);
  }
  // A breath of filtered noise, for movement.
  function air({ at = 0, length = 0.14, from = 900, to = 2400, level = 0.08 }) {
    const start = context.currentTime + at;
    const frames = Math.ceil(context.sampleRate * length);
    const buffer = context.createBuffer(1, frames, context.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < frames; i++) data[i] = Math.random() * 2 - 1;
    const source = context.createBufferSource(), filter = context.createBiquadFilter(), gain = context.createGain();
    source.buffer = buffer;
    filter.type = 'bandpass'; filter.Q.value = 1.4;
    filter.frequency.setValueAtTime(from, start);
    filter.frequency.exponentialRampToValueAtTime(to, start + length);
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(level, start + length * 0.3);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + length);
    source.connect(filter).connect(gain).connect(out);
    source.start(start);
  }
  const chime = (steps, { gap = 0.07, length = 0.22, level = 0.16, at = 0 } = {}) => steps.forEach((step, i) => {
    tone({ at: at + i * gap, from: NOTE(step), length, level, shape: 'triangle' });
    tone({ at: at + i * gap, from: NOTE(step + 12), length: length * 0.7, level: level * 0.25 });
  });

  const CUES = {
    tick: () => tone({ from: 1500, to: 1100, length: 0.03, level: 0.07 }),
    add: () => chime([7, 12], { gap: 0.055, length: 0.14 }),
    // Finishing tasks in quick succession climbs a scale: each step starts a note higher and a touch
    // softer, so a long run stays gentle. At the top it holds and adds a small sparkle instead of climbing on.
    done: ({ step = 0 } = {}) => {
      const rung = Math.min(step, CLIMB.length - 1), lift = CLIMB[rung];
      chime([3, 7, 10, 15].map(n => n + lift), { gap: 0.05, length: 0.24, level: 0.16 * (1 - rung * 0.045) });
      if (step >= CLIMB.length - 1) air({ at: 0.12, length: 0.3, from: 4000, to: 8000, level: 0.018 });
    },
    undone: () => chime([10, 5], { gap: 0.07, length: 0.16, level: 0.12 }),
    delete: () => { tone({ from: 440, to: 130, length: 0.2, level: 0.18, shape: 'triangle' }); air({ length: 0.16, from: 1800, to: 500, level: 0.04 }); },
    undo: () => { tone({ from: 180, to: 520, length: 0.18, level: 0.16, shape: 'triangle' }); tone({ at: 0.12, from: NOTE(12), length: 0.16, level: 0.1 }); },
    lift: () => tone({ from: 260, to: 390, length: 0.07, level: 0.14, shape: 'triangle' }),
    drop: () => { tone({ from: 300, to: 170, length: 0.09, level: 0.2, shape: 'triangle' }); tone({ at: 0.01, from: 900, to: 600, length: 0.04, level: 0.05 }); },
    // Each list has its own note, so moving between lists plays a little scale.
    nav: ({ index = 0, direction = 1 } = {}) => {
      air({ length: 0.16, from: direction > 0 ? 700 : 2400, to: direction > 0 ? 2400 : 700, level: 0.05 });
      chime([PENTATONIC[index % PENTATONIC.length]], { at: 0.05, length: 0.26, level: 0.13 });
    },
    open: () => chime([5, 12], { gap: 0.04, length: 0.12, level: 0.1 }),
    back: () => chime([12, 5], { gap: 0.04, length: 0.12, level: 0.1 }),
    pop: () => tone({ from: 520, to: 780, length: 0.06, level: 0.12 }),
    close: () => tone({ from: 700, to: 460, length: 0.06, level: 0.1 }),
    nope: () => { tone({ from: 150, length: 0.07, level: 0.2, shape: 'triangle' }); tone({ at: 0.1, from: 130, length: 0.09, level: 0.2, shape: 'triangle' }); },
    spread: () => { tone({ from: 300, to: 520, length: 0.09, level: 0.1, shape: 'triangle' }); air({ length: 0.1, from: 600, to: 1800, level: 0.03 }); },
    move: () => { air({ length: 0.18, from: 500, to: 2600, level: 0.05 }); chime([10, 15], { at: 0.06, gap: 0.05, length: 0.16, level: 0.11 }); },
    pick: () => chime([15, 10, 12, 19], { gap: 0.06, length: 0.14, level: 0.11 }),
    trophy: () => { chime([3, 7, 10, 15, 19], { gap: 0.09, length: 0.34, level: 0.17 }); chime([22, 27], { at: 0.5, gap: 0.12, length: 0.7, level: 0.14 }); air({ at: 0.45, length: 0.7, from: 2500, to: 8000, level: 0.03 }); },
    clear: () => { chime([3, 7, 10, 15, 19, 22], { gap: 0.065, length: 0.3 }); chime([27], { at: 0.42, length: 0.6, level: 0.12 }); air({ at: 0.36, length: 0.5, from: 3000, to: 7000, level: 0.03 }); },
  };

  function play(name, detail) {
    const cue = CUES[name];
    let played = false;
    if (cue && on && unlocked) {
      const ctx = engine();
      if (ctx) {
        if (ctx.state === 'suspended') ctx.resume().catch(() => {});
        if (ctx.state !== 'closed') { try { cue(detail); played = true; } catch { /* a cue must never break the app */ } }
      }
    }
    // Lets tests (and nothing else) observe which cues were asked for.
    document.dispatchEvent(new CustomEvent('quiet:cue', { detail: { name, played, step: detail?.step } }));
    return played;
  }

  // The first real touch or key press allows audio. Until then every cue is silently skipped.
  const unlock = () => { unlocked = true; report(); };
  for (const type of ['pointerdown', 'keydown']) addEventListener(type, unlock, { capture: true, once: true, passive: true });
  // Stop the engine while the app is in the background; it resumes on the next cue.
  document.addEventListener('visibilitychange', () => { if (document.hidden && context?.state === 'running') context.suspend().catch(() => {}); });
  report();

  return {
    play,
    get enabled() { return on; },
    setEnabled(value) {
      on = !!value;
      if (!on && context) { context.close().catch(() => {}); context = null; out = null; }
      report();
    },
  };
}
