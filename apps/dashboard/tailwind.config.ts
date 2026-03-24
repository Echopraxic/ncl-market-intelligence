import type { Config } from 'tailwindcss';
const config: Config = {
  content: ['./src/pages/**/*.{js,ts,jsx,tsx,mdx}','./src/components/**/*.{js,ts,jsx,tsx,mdx}','./src/app/**/*.{js,ts,jsx,tsx,mdx}'],
  theme: { extend: { colors: { navy: { 900: '#0B1F3A', 800: '#1a3a5c' }, gold: { 500: '#C8922A', 400: '#D4A843' } } } },
  plugins: [],
};
export default config;
