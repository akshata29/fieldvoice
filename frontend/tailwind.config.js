import plugin from 'tailwindcss/plugin';

const rgb = (name) => `rgb(var(${name}) / <alpha-value>)`;

/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        canvas: rgb('--c-canvas'),
        surface: rgb('--c-surface'),
        'surface-2': rgb('--c-surface-2'),
        ink: rgb('--c-ink'),
        muted: rgb('--c-muted'),
        line: rgb('--c-line'),
        brand: {
          50: '#eef6fc',
          100: '#d6e9f8',
          200: '#aed3f1',
          300: '#7fb8e6',
          400: '#4a98d6',
          500: '#1f7ac4',
          600: '#0067b8',
          700: '#00579c',
          800: '#0a4678',
          900: '#0c3a60',
        },
      },
      minHeight: { tap: 'var(--tap)' },
      minWidth: { tap: 'var(--tap)' },
      height: { tap: 'var(--tap)' },
      width: { tap: 'var(--tap)' },
      fontFamily: {
        sans: [
          'Segoe UI Variable Text',
          'Segoe UI',
          '-apple-system',
          'BlinkMacSystemFont',
          'SF Pro Text',
          'Roboto',
          'Helvetica Neue',
          'Arial',
          'sans-serif',
        ],
        mono: ['Cascadia Mono', 'SF Mono', 'Consolas', 'Menlo', 'monospace'],
      },
      boxShadow: {
        card: '0 1px 2px rgb(15 23 42 / 0.06), 0 1px 3px rgb(15 23 42 / 0.08)',
        pop: '0 10px 30px rgb(15 23 42 / 0.18), 0 2px 6px rgb(15 23 42 / 0.1)',
      },
      keyframes: {
        flash: {
          '0%': { backgroundColor: 'rgb(253 224 71 / 0.75)' },
          '100%': { backgroundColor: 'rgb(253 224 71 / 0)' },
        },
        'pulse-ring': {
          '0%': { boxShadow: '0 0 0 0 rgb(220 38 38 / 0.55)' },
          '100%': { boxShadow: '0 0 0 22px rgb(220 38 38 / 0)' },
        },
        'slide-up': {
          '0%': { opacity: '0', transform: 'translateY(8px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        blink: { '0%, 49%': { opacity: '1' }, '50%, 100%': { opacity: '0' } },
        indeterminate: {
          '0%': { transform: 'translateX(-100%)' },
          '100%': { transform: 'translateX(300%)' },
        },
      },
      animation: {
        flash: 'flash 1.6s ease-out 1',
        'pulse-ring': 'pulse-ring 1.4s ease-out infinite',
        'slide-up': 'slide-up 0.18s ease-out both',
        blink: 'blink 1s steps(1) infinite',
        indeterminate: 'indeterminate 1.2s ease-in-out infinite',
      },
    },
  },
  plugins: [
    plugin(({ addVariant }) => {
      addVariant('field', 'html[data-field-mode="on"] &');
    }),
  ],
};
