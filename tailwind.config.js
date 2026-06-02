/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        // Semantic tokens backed by CSS variables defined in styles.css (light
        // on :root, overridden under .dark). Channels are space-separated RGB so
        // Tailwind opacity modifiers like `bg-we-teal/10` still work.
        we: {
          teal: "rgb(var(--we-teal) / <alpha-value>)",        // accent / primary
          tealHover: "rgb(var(--we-teal-hover) / <alpha-value>)",
          ink: "rgb(var(--we-ink) / <alpha-value>)",          // primary text
          muted: "rgb(var(--we-muted) / <alpha-value>)",      // secondary text
          panel: "rgb(var(--we-panel) / <alpha-value>)",      // editor panels
          rail: "rgb(var(--we-rail) / <alpha-value>)",        // sidebar background
          border: "rgb(var(--we-border) / <alpha-value>)",
          hover: "rgb(var(--we-hover) / <alpha-value>)",      // button hover bg
          timeline: "rgb(var(--we-timeline) / <alpha-value>)",
          trackHead: "rgb(var(--we-trackHead) / <alpha-value>)",
          stage: "rgb(var(--we-stage) / <alpha-value>)",
        },
      },
      fontFamily: {
        sans: [
          "Inter",
          "ui-sans-serif",
          "system-ui",
          "-apple-system",
          "Segoe UI",
          "Roboto",
          "sans-serif",
        ],
      },
    },
  },
  plugins: [],
};
