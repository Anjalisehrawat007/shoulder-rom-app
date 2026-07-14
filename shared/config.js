// Point this at wherever you deploy /backend. For local development with
// `npm start` inside backend/, the default port is 4000; anywhere else
// (e.g. the Netlify-hosted frontend) it points at the Render deployment.
const BACKEND_URL =
  window.SHOULDER_ROM_BACKEND_URL ||
  (["localhost", "127.0.0.1"].includes(location.hostname)
    ? "http://localhost:4000"
    : "https://shoulder-rom-backend.onrender.com");
