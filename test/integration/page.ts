//! The page half of the integration e2e (bundled by Bun.build in the
//! test): the real @z2net/bunframe-view shim over the injected bootstrap.
import { defineRPC } from "@z2net/bunframe/view";
import type { AppRpc } from "./schema.ts";

const rpc = defineRPC<AppRpc>({ maxRequestTime: 1_000 });

const report = (partial: Record<string, unknown>): void => {
  void rpc.send.result(partial);
};

const state: Record<string, unknown> = {};
rpc.on.tick((tick) => {
  state.tick = tick;
  report({ tick });
});

const boot = async (): Promise<void> => {
  // Bind barrier: probe until the backend ipc callback answers.
  for (;;) {
    try {
      await rpc.request.probe({});
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  state.greet = await rpc.request.greet({ name: "bunframe" });
  report({ greet: state.greet });
  rpc.send.ready({ title: document.title });
};

void boot();
