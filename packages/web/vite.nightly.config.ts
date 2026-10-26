import base from "./vite.config";
export default { ...(typeof base === "function" ? {} : base), preview: { port: 5198, strictPort: true, proxy: { "/api": { target: "http://127.0.0.1:4391", changeOrigin: true, headers: { origin: "http://127.0.0.1:4391" } }, "/ws": { target: "ws://127.0.0.1:4391", ws: true, changeOrigin: true, headers: { origin: "http://127.0.0.1:4391" } } } } };
