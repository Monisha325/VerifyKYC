import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./src/**/*.{js,ts,jsx,tsx,mdx}'],
  theme: {
    extend: {
      colors: {
        brand: {
          // claw.md canonical colors
          navy:   '#1B4F72',   // primary
          blue:   '#2874A6',   // secondary
          orange: '#D35400',   // accent
          // Semantic aliases used in existing components
          green:  '#2874A6',   // success → brand blue
          amber:  '#D35400',   // warning → brand orange
        },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['"IBM Plex Mono"', 'ui-monospace', 'monospace'],
      },
      backgroundImage: {
        'navy-gradient': 'linear-gradient(135deg, #1B4F72 0%, #163d5a 60%, #0f2a40 100%)',
      },
      boxShadow: {
        'card':    '0 1px 3px 0 rgb(0 0 0 / 0.06), 0 1px 2px -1px rgb(0 0 0 / 0.06)',
        'card-lg': '0 4px 24px -4px rgb(0 0 0 / 0.10)',
      },
      keyframes: {
        'fade-up': {
          '0%':   { opacity: '0', transform: 'translateY(12px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        shake: {
          '0%, 100%': { transform: 'translateX(0)' },
          '15%':      { transform: 'translateX(-6px)' },
          '30%':      { transform: 'translateX(6px)' },
          '45%':      { transform: 'translateX(-4px)' },
          '60%':      { transform: 'translateX(4px)' },
          '75%':      { transform: 'translateX(-2px)' },
          '90%':      { transform: 'translateX(2px)' },
        },
        shimmer: {
          '0%':   { backgroundPosition: '-200% 0' },
          '100%': { backgroundPosition: '200% 0' },
        },
      },
      animation: {
        'fade-up': 'fade-up 0.35s ease-out both',
        shimmer:   'shimmer 1.6s linear infinite',
        shake:     'shake 0.45s ease-in-out both',
      },
    },
  },
  plugins: [],
};
export default config;
