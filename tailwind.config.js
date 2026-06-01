/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Approximated from WeVideo screenshots — refine as we iterate.
        we: {
          teal: "#1aa6b7",          // accent / primary buttons & timeline highlights
          tealHover: "#168a99",
          ink: "#1f2937",            // primary text
          muted: "#6b7280",          // secondary text
          panel: "#ffffff",          // editor panels
          rail: "#f9fafb",           // sidebar background
          border: "#e5e7eb",
          timeline: "#0f172a",       // timeline ruler / dark accents
          trackHead: "#f3f4f6",
          stage: "#000000",          // preview stage background
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
