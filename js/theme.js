// Single source of truth for colour, spacing and motion. The stylesheet reads these as custom
// properties (applyThemeVars) and the canvas reads the same objects, so a token change cannot land
// on one side only — which is how "one line colour" turns into forty.
//
// 埋方块 needs one token group the slant shell never had: a colour per 数字. A region's fill is that
// colour, the palette button for that digit is the same colour, and the legend swatch is a third
// copy of it — all three read this array, so "4 is that teal" is one fact in the file rather than
// three places that can drift.

export const Palette = {
  bgTop: '#080B16',
  bgBottom: '#131A2E',
  surface: '#101627',
  surfaceLift: '#182036',
  line: '#243050',
  lineHeavy: '#3A4A72',
  ink: '#F2F5FB',
  inkDim: 'rgba(242,245,251,0.62)',
  inkFaint: 'rgba(242,245,251,0.34)',

  // Amber is the player's own hand: the digit being dragged, the cell a hint just named and the
  // win banner all borrow it, so "this is what you are doing" reads as one idea. The numbers the
  // author printed stay bright white — the two are never the same colour, which is what lets you
  // see at a glance which 4 you wrote yourself.
  accent: '#FFC85C',
  accentEdge: '#FFE3A6',
  accentSoft: 'rgba(255,200,92,0.14)',

  // A region's outline is this game's live feedback, and it only ever reports a verdict the engine
  // already made: blue while the block is still short of its own number, green when the cell count
  // equals the digit, red when the block has outgrown it or run out of room.
  info: '#7BB8FF',
  pencilStrong: '#8FA6CC',
  pencil: 'rgba(242,245,251,0.30)',

  success: '#3DDC91',
  error: '#FF5C7A',
  // A wrong block is filled with this as well as outlined in `error`, because a red rim around a
  // teal blob is easy to read as decoration.
  errorFill: '#4C1D2B',
  warn: '#FFB05C',
  focus: 'rgba(123,184,255,0.16)',
  hint: '#7BB8FF',
};

// Index 0 is the digit 1. Eight entries cover MAX_K_CEIL, so the largest board this engine may
// declare has a colour of its own and no modulo arithmetic in the renderer.
export const DigitFill = [
  '#16243C', // 1 — a lone square sits close to the paper
  '#1A3A57', // 2
  '#1F4A43', // 3
  '#423318', // 4
  '#3C2138', // 5
  '#27305C', // 6
  '#482424', // 7
  '#1F454E', // 8
];

export const Space = { page: 20, card: 16, inner: 12, gutter: 10 };
export const Radius = { card: 20, button: 12, chip: 8, cell: 3 };

export const Font = {
  title: "700 24px/1.25 -apple-system, 'SF Pro Display', system-ui, sans-serif",
  mono: "'SF Mono', ui-monospace, SFMono-Regular, Menlo, monospace",
  sans: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'PingFang SC', system-ui, sans-serif",
};

// Durations obey the 150–350 ms discipline; anything longer blocks the next move.
export const Motion = {
  tap: 150,
  base: 220,
  pop: 260,
  line: 300,
  win: 900,
  spring: 'cubic-bezier(0.34, 1.45, 0.64, 1)',
  ease: 'cubic-bezier(0.22, 0.61, 0.36, 1)',
};

export const Cell = { min: 22, max: 56, pad: 16, lineScale: 0.1, digitScale: 0.44 };

export function applyThemeVars() {
  const root = document.documentElement.style;
  const kebab = (s) => s.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase());
  for (const [k, v] of Object.entries(Palette)) {
    if (Array.isArray(v)) continue;
    root.setProperty('--' + kebab(k), v);
  }
  // One custom property per digit, so a palette button and the blob it paints cannot disagree.
  DigitFill.forEach((c, i) => root.setProperty(`--digit-fill-${i + 1}`, c));
  for (const [k, v] of Object.entries(Space)) root.setProperty('--space-' + k, v + 'px');
  for (const [k, v] of Object.entries(Radius)) root.setProperty('--radius-' + k, v + 'px');
  for (const [k, v] of Object.entries(Motion)) {
    if (typeof v === 'number') root.setProperty('--dur-' + kebab(k), v + 'ms');
    else root.setProperty('--ease-' + kebab(k), v);
  }
  root.setProperty('--font-mono', Font.mono);
  root.setProperty('--font-sans', Font.sans);
}

// The system preference is the floor, and the in-game toggle can only add to it — a player who
// asks for less motion should not be overruled by an OS set to "no preference".
let motionReduced = false;

export function setReduceMotion(v) {
  motionReduced = !!v;
}

export const systemPrefersReducedMotion = () =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

export const prefersReducedMotion = () => motionReduced || systemPrefersReducedMotion();
