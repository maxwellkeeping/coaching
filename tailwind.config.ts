import type { Config } from 'tailwindcss'

const config: Config = {
  content: [
    './app/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
    './lib/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        background: '#0f1117',
        card: '#1a1d27',
        accent: '#3b82f6',
        'text-primary': '#e2e8f0',
        'text-muted': '#64748b',
      },
    },
  },
  plugins: [require('@tailwindcss/typography')],
}

export default config
