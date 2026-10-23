/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      fontFamily: { sans: ['Inter', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'sans-serif'] },
      colors: {
        brand: { 50: '#eef4fb', 100: '#d9e6f5', 600: '#1f4e8c', 700: '#183f72', 800: '#12305a' },
      },
    },
  },
  plugins: [],
};
