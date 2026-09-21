//! The backend entry: createApp opens the window, the registry
//! answers the page. Handlers are SYNC per call - long work belongs
//! in a Bun worker.
import { createApp } from "@z2net/bunframe";

import { rpc } from "./rpc.ts";

// `bunframe dev` injects the dev server URL; a built app serves the
// bundled frontend through the bf:// asset protocol.
const devUrl = process.env.BUNFRAME_DEV_URL;

const app = createApp({
  rpc,
  window: {
    title: "my-bunframe-app",
    ...(devUrl !== undefined
      ? { url: devUrl }
      : {
          url: "bf://localhost/index.html",
          asset_root: `${import.meta.dir}/../frontend`,
        }),
  },
});

app.handle("greet", ({ name }) => ({ message: `Hello, ${name}!` }));

await app.run();
