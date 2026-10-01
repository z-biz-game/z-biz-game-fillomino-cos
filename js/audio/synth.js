// Synthesised feedback, no sample files. A puzzle game's sound is a *state* readout — "a number
// went down", "that number breaks a block", "every block adds up" — and each of those is one short
// envelope, so a synth keeps the artifact small and the vocabulary honest.

let ctx = null;
let master = null;
let enabled = true;
// 计数是为了让"静音"这两个字可被验伪：关掉音效之后再按十次格子，这个数必须一动不动。
let voices = 0;
let resumes = 0;

function audio() {
  // 静音态连上下文都不必建：一个被建起来并被 resume 的 AudioContext 就是"假静音"的证据。
  if (!enabled) return null;
  if (typeof AudioContext === 'undefined' && typeof webkitAudioContext === 'undefined') return null;
  if (!ctx) {
    const Ctor = typeof AudioContext !== 'undefined' ? AudioContext : webkitAudioContext;
    try {
      ctx = new Ctor();
      master = ctx.createGain();
      master.gain.value = 0.5;
      master.connect(ctx.destination);
    } catch {
      return null;
    }
  }
  if (ctx.state === 'suspended') {
    resumes++;
    ctx.resume().catch(() => {});
  }
  return ctx;
}

// One oscillator with a two-point pitch glide and an exponential decay. Everything below is
// a call to this; adding a second voice shape is how a game ends up with sounds that do not
// belong to the same instrument.
function tone({ f0, f1 = f0, dur = 0.12, type = 'sine', gain = 0.22, delay = 0 }) {
  const ac = audio();
  if (!ac) return false;
  const t = ac.currentTime + delay;
  const osc = ac.createOscillator();
  const vol = ac.createGain();
  voices++;
  osc.type = type;
  osc.frequency.setValueAtTime(f0, t);
  osc.frequency.exponentialRampToValueAtTime(Math.max(40, f1), t + dur);
  vol.gain.setValueAtTime(0.0001, t);
  vol.gain.exponentialRampToValueAtTime(gain, t + 0.012);
  vol.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(vol).connect(master);
  osc.start(t);
  osc.stop(t + dur + 0.02);
  return true;
}

export const Sound = {
  // 真静音 = 停掉时钟 + 不再新建振荡器，而不是把 master gain 拧到 0：前者让已经排队的
  // 包络也一起停在半空，后者只是把声音藏起来，节点照样在跑。
  setEnabled(v) {
    const on = !!v;
    if (on !== enabled) {
      enabled = on;
      if (ctx) {
        if (!on && ctx.state === 'running') ctx.suspend().catch(() => {});
        if (on && ctx.state === 'suspended') {
          resumes++;
          ctx.resume().catch(() => {});
        }
      }
    }
    return on;
  },
  enabled: () => enabled,
  stats: () => ({ enabled, voices, resumes, state: ctx ? ctx.state : 'none' }),
  // 测试与对拍用的清零口：不重建上下文，只把计数器归零。
  resetStats() {
    voices = 0;
    resumes = 0;
  },

  place() {
    tone({ f0: 520, f1: 880, dur: 0.14, type: 'triangle', gain: 0.2 });
  },
  rub() {
    tone({ f0: 300, f1: 240, dur: 0.07, type: 'square', gain: 0.07 });
  },
  erase() {
    tone({ f0: 240, f1: 180, dur: 0.08, type: 'sine', gain: 0.1 });
  },
  undo() {
    tone({ f0: 420, f1: 300, dur: 0.11, type: 'triangle', gain: 0.13 });
  },
  // Two detuned voices: an interval that is deliberately unpleasant, for the one thing the
  // player must notice without looking.
  conflict() {
    tone({ f0: 200, f1: 150, dur: 0.16, type: 'sawtooth', gain: 0.11 });
    tone({ f0: 214, f1: 158, dur: 0.16, type: 'sawtooth', gain: 0.09, delay: 0.01 });
  },
  hint() {
    tone({ f0: 760, f1: 1020, dur: 0.16, type: 'sine', gain: 0.16 });
    tone({ f0: 1140, dur: 0.1, type: 'sine', gain: 0.07, delay: 0.06 });
  },
  win() {
    [523, 659, 784, 1046].forEach((f, i) => tone({ f0: f, dur: 0.26, type: 'triangle', gain: 0.17, delay: i * 0.09 }));
  },
};
